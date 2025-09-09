class JobManager {
  constructor(supabase, logger) {
    this.supabase = supabase;
    this.logger = logger;
  }

  async startJob({ job_id, platform, url, full_history = true }) {
    try {
      this.logger.info(`🚀 Starting job ${job_id} for ${platform}: ${url}`);

      // Get job details from database
      const { data: job, error: jobError } = await this.supabase
        .from('review_sync_jobs')
        .select('*')
        .eq('id', job_id)
        .single();

      if (jobError || !job) {
        throw new Error(`Job ${job_id} not found in database`);
      }

      // Update job status to running if it's not already
      if (job.status !== 'running') {
        await this.supabase
          .from('review_sync_jobs')
          .update({
            status: 'running',
            started_at: new Date().toISOString(),
            progress_percentage: 0,
            updated_at: new Date().toISOString()
          })
          .eq('id', job_id);
      }

      // Send started notification
      await this.sendNotification(job_id, job.tour_operator_id, 'started', 
        `Review import started for ${job.source_business_name || 'your business'}`);

      // Estimate completion time based on full_history setting
      const estimatedMinutes = full_history ? 15 : 5;
      const estimatedCompletion = new Date(Date.now() + estimatedMinutes * 60000);

      return {
        job_id,
        status: 'running',
        estimated_completion: estimatedCompletion.toISOString(),
        message: 'Job started successfully'
      };

    } catch (error) {
      this.logger.error(`Error starting job ${job_id}:`, error);
      throw error;
    }
  }

  async getJobStatus(jobId) {
    try {
      const { data: job, error } = await this.supabase
        .from('review_sync_jobs')
        .select(`
          id,
          platform,
          source_business_name,
          status,
          imported_count,
          total_available,
          progress_percentage,
          started_at,
          completed_at,
          updated_at,
          error,
          full_history
        `)
        .eq('id', jobId)
        .single();

      if (error || !job) {
        throw new Error(`Job ${jobId} not found`);
      }

      // Calculate additional status info
      const now = new Date();
      const startTime = new Date(job.started_at);
      const elapsedMinutes = Math.floor((now - startTime) / 60000);

      let estimatedTimeRemaining = null;
      if (job.status === 'running' || job.status === 'processing') {
        const totalEstimatedMinutes = job.full_history ? 15 : 5;
        const remainingMinutes = Math.max(0, totalEstimatedMinutes - elapsedMinutes);
        estimatedTimeRemaining = remainingMinutes;
      }

      return {
        ...job,
        elapsed_minutes: elapsedMinutes,
        estimated_time_remaining_minutes: estimatedTimeRemaining,
        reviews_per_minute: job.imported_count && elapsedMinutes > 0 
          ? Math.round(job.imported_count / elapsedMinutes) 
          : null
      };

    } catch (error) {
      this.logger.error(`Error getting job status ${jobId}:`, error);
      throw error;
    }
  }

  async getProcessingStats() {
    try {
      // Get overall statistics
      const { data: stats, error } = await this.supabase
        .rpc('get_processing_stats');

      if (error) {
        this.logger.error('Error getting processing stats:', error);
        // Return basic stats if RPC fails
        return await this.getBasicStats();
      }

      return stats;

    } catch (error) {
      this.logger.error('Error in getProcessingStats:', error);
      return await this.getBasicStats();
    }
  }

  async getBasicStats() {
    try {
      // Get basic statistics using regular queries
      const { data: jobs, error: jobsError } = await this.supabase
        .from('review_sync_jobs')
        .select('status, imported_count, created_at')
        .gte('created_at', new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString()); // Last 30 days

      if (jobsError) {
        throw jobsError;
      }

      const totalJobs = jobs.length;
      const runningJobs = jobs.filter(j => j.status === 'running' || j.status === 'processing').length;
      const completedJobs = jobs.filter(j => j.status === 'succeeded').length;
      const failedJobs = jobs.filter(j => j.status === 'failed').length;
      const totalReviews = jobs.reduce((sum, j) => sum + (j.imported_count || 0), 0);

      return {
        total_jobs: totalJobs,
        running_jobs: runningJobs,
        completed_jobs: completedJobs,
        failed_jobs: failedJobs,
        total_reviews_imported: totalReviews,
        success_rate: totalJobs > 0 ? Math.round((completedJobs / totalJobs) * 100) : 0,
        average_reviews_per_job: totalJobs > 0 ? Math.round(totalReviews / totalJobs) : 0
      };

    } catch (error) {
      this.logger.error('Error getting basic stats:', error);
      return {
        total_jobs: 0,
        running_jobs: 0,
        completed_jobs: 0,
        failed_jobs: 0,
        total_reviews_imported: 0,
        success_rate: 0,
        average_reviews_per_job: 0
      };
    }
  }

  async getJobHistory(userId, limit = 10) {
    try {
      const { data: jobs, error } = await this.supabase
        .from('review_sync_jobs')
        .select(`
          id,
          platform,
          source_business_name,
          status,
          imported_count,
          total_available,
          progress_percentage,
          started_at,
          completed_at,
          error
        `)
        .eq('tour_operator_id', userId)
        .order('started_at', { ascending: false })
        .limit(limit);

      if (error) {
        throw error;
      }

      return jobs || [];

    } catch (error) {
      this.logger.error(`Error getting job history for user ${userId}:`, error);
      throw error;
    }
  }

  async cancelJob(jobId, userId) {
    try {
      // Verify job belongs to user
      const { data: job, error: jobError } = await this.supabase
        .from('review_sync_jobs')
        .select('tour_operator_id, status')
        .eq('id', jobId)
        .single();

      if (jobError || !job) {
        throw new Error('Job not found');
      }

      if (job.tour_operator_id !== userId) {
        throw new Error('Unauthorized to cancel this job');
      }

      if (!['running', 'processing'].includes(job.status)) {
        throw new Error('Job cannot be cancelled in current status');
      }

      // Update job status
      await this.supabase
        .from('review_sync_jobs')
        .update({
          status: 'cancelled',
          updated_at: new Date().toISOString(),
          error: 'Cancelled by user'
        })
        .eq('id', jobId);

      // Send cancellation notification
      await this.sendNotification(jobId, userId, 'cancelled', 'Review import was cancelled');

      this.logger.info(`Job ${jobId} cancelled by user ${userId}`);

      return { success: true, message: 'Job cancelled successfully' };

    } catch (error) {
      this.logger.error(`Error cancelling job ${jobId}:`, error);
      throw error;
    }
  }

  async retryJob(jobId, userId) {
    try {
      // Verify job belongs to user
      const { data: job, error: jobError } = await this.supabase
        .from('review_sync_jobs')
        .select('*')
        .eq('id', jobId)
        .eq('tour_operator_id', userId)
        .single();

      if (jobError || !job) {
        throw new Error('Job not found');
      }

      if (job.status !== 'failed') {
        throw new Error('Only failed jobs can be retried');
      }

      // Reset job status
      await this.supabase
        .from('review_sync_jobs')
        .update({
          status: 'running',
          started_at: new Date().toISOString(),
          progress_percentage: 0,
          imported_count: 0,
          error: null,
          updated_at: new Date().toISOString(),
          last_cursor: null // Reset cursor to start fresh
        })
        .eq('id', jobId);

      // Send retry notification
      await this.sendNotification(jobId, userId, 'started', 'Review import restarted');

      this.logger.info(`Job ${jobId} retried by user ${userId}`);

      return { success: true, message: 'Job restarted successfully' };

    } catch (error) {
      this.logger.error(`Error retrying job ${jobId}:`, error);
      throw error;
    }
  }

  async sendNotification(jobId, userId, type, message) {
    try {
      await this.supabase
        .from('job_notifications')
        .insert({
          user_id: userId,
          job_id: jobId,
          type,
          message
        });

      this.logger.info(`Notification sent for job ${jobId}: ${type} - ${message}`);

    } catch (error) {
      this.logger.error('Failed to send notification:', error);
      // Don't throw error for notification failures
    }
  }

  async cleanupOldJobs(daysOld = 30) {
    try {
      const cutoffDate = new Date(Date.now() - daysOld * 24 * 60 * 60 * 1000);
      
      const { data: deletedJobs, error } = await this.supabase
        .from('review_sync_jobs')
        .delete()
        .in('status', ['succeeded', 'failed', 'cancelled'])
        .lt('completed_at', cutoffDate.toISOString())
        .select('id');

      if (error) {
        throw error;
      }

      const deletedCount = deletedJobs?.length || 0;
      this.logger.info(`🧹 Cleaned up ${deletedCount} old jobs`);

      return { deleted_count: deletedCount };

    } catch (error) {
      this.logger.error('Error cleaning up old jobs:', error);
      throw error;
    }
  }
}

module.exports = JobManager;


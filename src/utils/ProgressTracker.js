class ProgressTracker {
  constructor(supabase, logger) {
    this.supabase = supabase;
    this.logger = logger;
  }

  async updateProgress(jobId, progress) {
    try {
      const { error } = await this.supabase
        .from('review_sync_jobs')
        .update({
          progress_percentage: Math.min(100, Math.max(0, progress.percentage || 0)),
          imported_count: progress.imported_count || 0,
          total_available: progress.total_available || 0,
          updated_at: new Date().toISOString()
        })
        .eq('id', jobId);

      if (error) {
        this.logger.error(`Failed to update progress for job ${jobId}:`, error);
      } else {
        this.logger.info(`Updated progress for job ${jobId}: ${progress.percentage}%`);
      }

    } catch (error) {
      this.logger.error(`Error updating progress for job ${jobId}:`, error);
    }
  }

  async trackBatchProgress(jobId, batchIndex, totalBatches, batchSize, totalItems) {
    const processedItems = batchIndex * batchSize;
    const percentage = Math.min(95, Math.round((processedItems / totalItems) * 100));
    
    await this.updateProgress(jobId, {
      percentage,
      imported_count: processedItems,
      total_available: totalItems
    });
  }

  async completeProgress(jobId, finalCount, totalFound) {
    await this.updateProgress(jobId, {
      percentage: 100,
      imported_count: finalCount,
      total_available: totalFound
    });
  }
}

module.exports = ProgressTracker;


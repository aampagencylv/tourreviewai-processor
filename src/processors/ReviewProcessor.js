const axios = require('axios');
const DataForSEOClient = require('../utils/DataForSEOClient');
const ProgressTracker = require('../utils/ProgressTracker');

class ReviewProcessor {
  constructor(supabase, logger) {
    this.supabase = supabase;
    this.logger = logger;
    this.dataForSEO = new DataForSEOClient(logger);
    this.progressTracker = new ProgressTracker(supabase, logger);
    
    // Processing configuration
    this.config = {
      batchSize: 100,
      maxRetries: 3,
      retryDelay: 5000,
      maxConcurrentJobs: 5,
      pollInterval: 30000 // 30 seconds
    };
  }

  async processPendingJobs() {
    try {
      this.logger.info('🔄 Checking for pending jobs...');

      // Get running jobs that need processing
      const { data: jobs, error } = await this.supabase
        .from('review_sync_jobs')
        .select('*')
        .in('status', ['running', 'processing'])
        .order('started_at', { ascending: true })
        .limit(this.config.maxConcurrentJobs);

      if (error) {
        throw new Error(`Failed to fetch jobs: ${error.message}`);
      }

      if (!jobs || jobs.length === 0) {
        this.logger.info('📭 No pending jobs found');
        return [];
      }

      this.logger.info(`📋 Found ${jobs.length} jobs to process`);

      const results = [];
      for (const job of jobs) {
        try {
          const result = await this.processJob(job.id);
          results.push({ job_id: job.id, success: true, result });
        } catch (error) {
          this.logger.error(`❌ Job ${job.id} failed:`, error);
          results.push({ job_id: job.id, success: false, error: error.message });
        }
      }

      return results;

    } catch (error) {
      this.logger.error('Error in processPendingJobs:', error);
      throw error;
    }
  }

  async processJob(jobId) {
    try {
      this.logger.info(`🚀 Processing job ${jobId}`);

      // Get job details
      const { data: job, error: jobError } = await this.supabase
        .from('review_sync_jobs')
        .select('*')
        .eq('id', jobId)
        .single();

      if (jobError || !job) {
        throw new Error(`Job ${jobId} not found`);
      }

      // Update job status to processing
      await this.updateJobStatus(jobId, 'processing', {
        progress_percentage: 5,
        updated_at: new Date().toISOString()
      });

      // Process based on platform
      let result;
      switch (job.platform) {
        case 'tripadvisor':
          result = await this.processTripAdvisorJob(job);
          break;
        case 'google':
          result = await this.processGoogleJob(job);
          break;
        default:
          throw new Error(`Unsupported platform: ${job.platform}`);
      }

      this.logger.info(`✅ Job ${jobId} completed successfully`);
      return result;

    } catch (error) {
      this.logger.error(`❌ Job ${jobId} failed:`, error);
      
      // Update job with error
      await this.updateJobStatus(jobId, 'failed', {
        error: error.message,
        updated_at: new Date().toISOString()
      });

      // Send failure notification
      await this.sendNotification(jobId, 'failed', `Import failed: ${error.message}`);
      
      throw error;
    }
  }

  async processTripAdvisorJob(job) {
    try {
      this.logger.info(`🏨 Processing TripAdvisor job for: ${job.source_business_name}`);

      const cursor = JSON.parse(job.last_cursor || '{}');
      let taskId = cursor.task_id;

      // If no task ID, create new DataForSEO task
      if (!taskId) {
        this.logger.info('📝 Creating new DataForSEO task...');
        
        const urlPath = this.extractTripAdvisorPath(job.source_business_id);
        taskId = await this.dataForSEO.createTripAdvisorTask(urlPath, job.full_history);
        
        // Update job with task ID
        await this.updateJobStatus(job.id, 'processing', {
          last_cursor: JSON.stringify({ task_id: taskId, created_at: new Date().toISOString() }),
          progress_percentage: 10
        });

        this.logger.info(`📋 Created DataForSEO task: ${taskId}`);
        
        // Wait a bit for task to start processing
        await this.sleep(10000);
      }

      // Poll for results
      const results = await this.pollDataForSEOResults(taskId, job.platform);
      
      if (!results || results.length === 0) {
        throw new Error('No results returned from DataForSEO');
      }

      // Extract all reviews from results
      let allReviews = [];
      for (const result of results) {
        if (result.items && Array.isArray(result.items)) {
          allReviews = allReviews.concat(result.items);
        }
      }

      this.logger.info(`📊 Found ${allReviews.length} reviews to process`);

      if (allReviews.length === 0) {
        await this.completeJob(job.id, 0, 0);
        return { reviews_processed: 0, total_found: 0 };
      }

      // Process reviews in batches
      const processedCount = await this.processReviewBatches(job, allReviews);

      // Complete the job
      await this.completeJob(job.id, processedCount, allReviews.length);

      return {
        reviews_processed: processedCount,
        total_found: allReviews.length,
        task_id: taskId
      };

    } catch (error) {
      this.logger.error('TripAdvisor processing error:', error);
      throw error;
    }
  }

  async processReviewBatches(job, allReviews) {
    let processedCount = 0;
    const totalReviews = allReviews.length;
    
    // Process in batches to avoid memory issues and provide progress updates
    for (let i = 0; i < allReviews.length; i += this.config.batchSize) {
      const batch = allReviews.slice(i, i + this.config.batchSize);
      
      try {
        // Transform reviews to database format
        const reviewsToInsert = batch.map((review, index) => {
          return this.transformReviewData(review, job, i + index);
        }).filter(review => review && review.external_id);

        if (reviewsToInsert.length === 0) {
          continue;
        }

        // Insert batch into database
        const { error: insertError } = await this.supabase
          .from('external_reviews')
          .upsert(reviewsToInsert, { 
            onConflict: 'tour_operator_id,source,external_id',
            ignoreDuplicates: false 
          });

        if (insertError) {
          this.logger.error('Batch insert error:', insertError);
          // Continue with other batches even if one fails
        } else {
          processedCount += reviewsToInsert.length;
        }

        // Update progress
        const progressPercentage = Math.min(95, Math.round(((i + batch.length) / totalReviews) * 85) + 10);
        await this.updateJobStatus(job.id, 'processing', {
          imported_count: processedCount,
          total_available: totalReviews,
          progress_percentage: progressPercentage,
          updated_at: new Date().toISOString()
        });

        // Send progress notification every 25%
        if (progressPercentage % 25 === 0 && progressPercentage > 0) {
          await this.sendNotification(
            job.id, 
            'progress', 
            `Processing ${processedCount} of ${totalReviews} reviews (${progressPercentage}%)`
          );
        }

        this.logger.info(`📈 Processed batch ${Math.ceil((i + batch.length) / this.config.batchSize)} - ${processedCount}/${totalReviews} reviews`);

        // Small delay to prevent overwhelming the database
        await this.sleep(100);

      } catch (error) {
        this.logger.error(`Batch processing error (batch ${i}-${i + batch.length}):`, error);
        // Continue with next batch
      }
    }

    return processedCount;
  }

  transformReviewData(review, job, index) {
    try {
      // Handle different review formats from DataForSEO
      const externalId = review.review_id || 
                        review.id || 
                        `${job.platform}_${job.id}_${index}_${Date.now()}`;
      
      const authorName = review.user_profile?.name || 
                        review.author || 
                        review.reviewer_name || 
                        'Anonymous';
      
      const rating = Math.max(1, Math.min(5, 
        review.rating?.value || 
        review.rating || 
        review.score || 
        5
      ));
      
      const reviewText = (review.review_text || 
                         review.text || 
                         review.content || 
                         '').substring(0, 2000);
      
      const postedAt = review.date_of_review || 
                      review.published_at || 
                      review.created_at || 
                      review.date ||
                      new Date().toISOString();

      return {
        tour_operator_id: job.tour_operator_id,
        source: job.platform,
        external_id: externalId,
        author_name: authorName.substring(0, 255),
        rating: rating,
        text: reviewText || null,
        posted_at: new Date(postedAt).toISOString(),
        review_url: review.url || review.link || null,
        author_photo_url: review.user_profile?.photo_url || review.avatar || null,
        place_name: job.source_business_name,
        helpful_count: review.helpful_count || review.likes || 0,
        response_text: review.response?.text || null,
        response_date: review.response?.date ? new Date(review.response.date).toISOString() : null
      };

    } catch (error) {
      this.logger.error('Error transforming review data:', error);
      return null;
    }
  }

  async pollDataForSEOResults(taskId, platform) {
    const maxPolls = 60; // 30 minutes max (30 second intervals)
    let pollCount = 0;

    while (pollCount < maxPolls) {
      try {
        this.logger.info(`🔍 Polling DataForSEO results (attempt ${pollCount + 1}/${maxPolls})`);

        const results = await this.dataForSEO.getTaskResults(taskId, platform);
        
        if (results && results.length > 0) {
          this.logger.info(`✅ Results ready! Found ${results.length} result sets`);
          return results;
        }

        // Wait before next poll
        await this.sleep(this.config.pollInterval);
        pollCount++;

      } catch (error) {
        if (error.message.includes('Task In Queue') || error.message.includes('Task Processing')) {
          this.logger.info('⏳ Task still processing, waiting...');
          await this.sleep(this.config.pollInterval);
          pollCount++;
          continue;
        }
        
        throw error;
      }
    }

    throw new Error('DataForSEO task timed out after 30 minutes');
  }

  async completeJob(jobId, processedCount, totalFound) {
    await this.updateJobStatus(jobId, 'succeeded', {
      imported_count: processedCount,
      total_available: totalFound,
      progress_percentage: 100,
      completed_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    });

    await this.sendNotification(
      jobId, 
      'completed', 
      `Successfully imported ${processedCount} reviews from ${totalFound} found`
    );

    this.logger.info(`🎉 Job ${jobId} completed: ${processedCount}/${totalFound} reviews imported`);
  }

  async updateJobStatus(jobId, status, updates = {}) {
    const { error } = await this.supabase
      .from('review_sync_jobs')
      .update({ status, ...updates })
      .eq('id', jobId);

    if (error) {
      this.logger.error(`Failed to update job ${jobId}:`, error);
    }
  }

  async sendNotification(jobId, type, message) {
    try {
      // Get job details for user_id
      const { data: job } = await this.supabase
        .from('review_sync_jobs')
        .select('tour_operator_id')
        .eq('id', jobId)
        .single();

      if (!job) return;

      await this.supabase
        .from('job_notifications')
        .insert({
          user_id: job.tour_operator_id,
          job_id: jobId,
          type,
          message
        });

    } catch (error) {
      this.logger.error('Failed to send notification:', error);
    }
  }

  extractTripAdvisorPath(businessId) {
    // Extract path from TripAdvisor URL or business ID
    if (businessId.startsWith('http')) {
      const patterns = [
        /tripadvisor\.com(\/(Attraction_Review|Restaurant_Review|Hotel_Review)-g\d+-d\d+-Reviews-.+\.html)/,
        /tripadvisor\.com(\/.*-Reviews-.+\.html)/,
      ];
      
      for (const pattern of patterns) {
        const match = businessId.match(pattern);
        if (match) return match[1];
      }
      
      throw new Error('Invalid TripAdvisor URL format');
    }
    
    return businessId; // Assume it's already a path
  }

  sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

module.exports = ReviewProcessor;


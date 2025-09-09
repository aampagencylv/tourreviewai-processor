const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const { createClient } = require('@supabase/supabase-js');
const winston = require('winston');
require('dotenv').config();

const ReviewProcessor = require('./processors/ReviewProcessor');
const JobManager = require('./managers/JobManager');

// Configure logging
const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.errors({ stack: true }),
    winston.format.json()
  ),
  transports: [
    new winston.transports.Console({
      format: winston.format.combine(
        winston.format.colorize(),
        winston.format.simple()
      )
    })
  ]
});

// Initialize Express app
const app = express();
const PORT = process.env.PORT || 3000;

// Security middleware
app.use(helmet());
app.use(cors({
  origin: process.env.ALLOWED_ORIGINS?.split(',') || ['http://localhost:3000', 'https://your-app.vercel.app'],
  credentials: true
}));

// Rate limiting
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // limit each IP to 100 requests per windowMs
  message: 'Too many requests from this IP, please try again later.'
});
app.use(limiter);

// Body parsing
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// Initialize Supabase client
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// Initialize services
const jobManager = new JobManager(supabase, logger);
const reviewProcessor = new ReviewProcessor(supabase, logger);

// Root endpoint for Railway routing test
app.get('/', (req, res) => {
  res.json({
    status: 'healthy',
    service: 'TourReviewAI Processing Service',
    timestamp: new Date().toISOString(),
    version: '1.0.0',
    uptime: process.uptime(),
    port: PORT
  });
});

// Health check endpoint - Railway deployment fix v2
app.get('/health', (req, res) => {
  res.json({
    status: 'healthy',
    timestamp: new Date().toISOString(),
    version: '1.0.0',
    uptime: process.uptime()
  });
});

// Start review import job
app.post('/api/import/start', async (req, res) => {
  try {
    const { job_id, platform, url, full_history = true } = req.body;

    if (!job_id || !platform || !url) {
      return res.status(400).json({
        success: false,
        error: 'Missing required fields: job_id, platform, url'
      });
    }

    logger.info(`Starting import job ${job_id} for ${platform}: ${url}`);

    // Add job to processing queue
    const result = await jobManager.startJob({
      job_id,
      platform,
      url,
      full_history
    });

    res.json({
      success: true,
      job_id,
      message: 'Import job started successfully',
      estimated_completion: result.estimated_completion
    });

  } catch (error) {
    logger.error('Error starting import job:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Get job status
app.get('/api/job/:job_id/status', async (req, res) => {
  try {
    const { job_id } = req.params;
    const status = await jobManager.getJobStatus(job_id);
    
    res.json({
      success: true,
      job: status
    });

  } catch (error) {
    logger.error('Error getting job status:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Process pending jobs (called by cron or manually)
app.post('/api/process/pending', async (req, res) => {
  try {
    logger.info('Processing pending jobs...');
    
    const results = await reviewProcessor.processPendingJobs();
    
    res.json({
      success: true,
      processed_jobs: results.length,
      results
    });

  } catch (error) {
    logger.error('Error processing pending jobs:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Manual job processing trigger
app.post('/api/job/:job_id/process', async (req, res) => {
  try {
    const { job_id } = req.params;
    
    logger.info(`Manually processing job ${job_id}`);
    
    const result = await reviewProcessor.processJob(job_id);
    
    res.json({
      success: true,
      job_id,
      result
    });

  } catch (error) {
    logger.error(`Error processing job ${req.params.job_id}:`, error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Get processing statistics
app.get('/api/stats', async (req, res) => {
  try {
    const stats = await jobManager.getProcessingStats();
    
    res.json({
      success: true,
      stats
    });

  } catch (error) {
    logger.error('Error getting stats:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Error handling middleware
app.use((error, req, res, next) => {
  logger.error('Unhandled error:', error);
  res.status(500).json({
    success: false,
    error: 'Internal server error'
  });
});

// 404 handler
app.use('*', (req, res) => {
  res.status(404).json({
    success: false,
    error: 'Endpoint not found'
  });
});

// Start server
app.listen(PORT, '0.0.0.0', () => {
  logger.info(`🚀 TourReviewAI Processing Service started on port ${PORT}`);
  logger.info(`📊 Health check: http://localhost:${PORT}/health`);
  
  // Start background job processing (disabled temporarily for debugging)
  // setInterval(async () => {
  //   try {
  //     await reviewProcessor.processPendingJobs();
  //   } catch (error) {
  //     logger.error('Background processing error:', error);
  //   }
  // }, 60000); // Process every minute
});

// Graceful shutdown
process.on('SIGTERM', () => {
  logger.info('SIGTERM received, shutting down gracefully');
  process.exit(0);
});

process.on('SIGINT', () => {
  logger.info('SIGINT received, shutting down gracefully');
  process.exit(0);
});

module.exports = app;


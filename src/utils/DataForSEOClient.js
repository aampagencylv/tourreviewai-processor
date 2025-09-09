const axios = require('axios');

class DataForSEOClient {
  constructor(logger) {
    this.logger = logger;
    this.username = process.env.DATAFORSEO_USERNAME;
    this.password = process.env.DATAFORSEO_PASSWORD;
    
    if (!this.username || !this.password) {
      throw new Error('DataForSEO credentials not configured');
    }

    this.baseURL = 'https://api.dataforseo.com/v3/business_data';
    this.auth = Buffer.from(`${this.username}:${this.password}`).toString('base64');
  }

  async createTripAdvisorTask(urlPath, fullHistory = true) {
    try {
      this.logger.info(`📝 Creating TripAdvisor task for: ${urlPath}`);

      const taskData = [{
        url_path: urlPath,
        priority: 2,
        depth: fullHistory ? 500 : 100, // Reasonable limits
        tag: `tripadvisor_${Date.now()}`
      }];

      const response = await axios.post(
        `${this.baseURL}/tripadvisor/reviews/task_post`,
        taskData,
        {
          headers: {
            'Authorization': `Basic ${this.auth}`,
            'Content-Type': 'application/json',
          },
          timeout: 30000
        }
      );

      const result = response.data;
      
      if (!result.tasks?.[0]?.id) {
        throw new Error(`DataForSEO task creation failed: ${JSON.stringify(result)}`);
      }

      const taskId = result.tasks[0].id;
      this.logger.info(`✅ Created DataForSEO task: ${taskId}`);
      
      return taskId;

    } catch (error) {
      this.logger.error('DataForSEO task creation error:', error);
      
      if (error.response) {
        throw new Error(`DataForSEO API error: ${error.response.status} - ${JSON.stringify(error.response.data)}`);
      }
      
      throw new Error(`DataForSEO request failed: ${error.message}`);
    }
  }

  async createGoogleTask(businessId, fullHistory = true) {
    try {
      this.logger.info(`📝 Creating Google task for: ${businessId}`);

      const taskData = [{
        keyword: businessId,
        priority: 2,
        depth: fullHistory ? 500 : 100,
        tag: `google_${Date.now()}`
      }];

      const response = await axios.post(
        `${this.baseURL}/google/reviews/task_post`,
        taskData,
        {
          headers: {
            'Authorization': `Basic ${this.auth}`,
            'Content-Type': 'application/json',
          },
          timeout: 30000
        }
      );

      const result = response.data;
      
      if (!result.tasks?.[0]?.id) {
        throw new Error(`Google task creation failed: ${JSON.stringify(result)}`);
      }

      const taskId = result.tasks[0].id;
      this.logger.info(`✅ Created Google task: ${taskId}`);
      
      return taskId;

    } catch (error) {
      this.logger.error('Google task creation error:', error);
      
      if (error.response) {
        throw new Error(`DataForSEO API error: ${error.response.status} - ${JSON.stringify(error.response.data)}`);
      }
      
      throw new Error(`DataForSEO request failed: ${error.message}`);
    }
  }

  async getTaskResults(taskId, platform) {
    try {
      const endpoint = platform === 'tripadvisor' 
        ? `${this.baseURL}/tripadvisor/reviews/task_get/${taskId}`
        : `${this.baseURL}/google/reviews/task_get/${taskId}`;

      this.logger.info(`🔍 Fetching results for task ${taskId} (${platform})`);

      const response = await axios.get(endpoint, {
        headers: {
          'Authorization': `Basic ${this.auth}`,
        },
        timeout: 30000
      });

      const result = response.data;
      const taskResult = result.tasks?.[0];

      if (!taskResult) {
        throw new Error('No task result found');
      }

      const statusMessage = taskResult.status_message || '';
      
      // Check if task is still processing
      if (statusMessage === 'Task In Queue' || statusMessage === 'Task Processing') {
        throw new Error('Task still processing');
      }

      // Check for errors
      if (!statusMessage.toLowerCase().startsWith('ok')) {
        throw new Error(`DataForSEO task failed: ${statusMessage}`);
      }

      // Return results
      const results = taskResult.result || [];
      this.logger.info(`📊 Retrieved ${results.length} result sets from task ${taskId}`);
      
      return results;

    } catch (error) {
      if (error.message.includes('Task still processing') || 
          error.message.includes('Task In Queue')) {
        throw error; // Re-throw processing status errors
      }

      this.logger.error(`Error fetching results for task ${taskId}:`, error);
      
      if (error.response) {
        throw new Error(`DataForSEO API error: ${error.response.status} - ${JSON.stringify(error.response.data)}`);
      }
      
      throw new Error(`DataForSEO request failed: ${error.message}`);
    }
  }

  async getTaskStatus(taskId, platform) {
    try {
      const endpoint = platform === 'tripadvisor'
        ? `${this.baseURL}/tripadvisor/reviews/tasks_ready`
        : `${this.baseURL}/google/reviews/tasks_ready`;

      const response = await axios.get(endpoint, {
        headers: {
          'Authorization': `Basic ${this.auth}`,
        },
        timeout: 15000
      });

      const result = response.data;
      const readyTasks = result.tasks || [];
      
      // Check if our task is in the ready list
      const isReady = readyTasks.some(task => task.id === taskId);
      
      return {
        task_id: taskId,
        is_ready: isReady,
        ready_tasks_count: readyTasks.length
      };

    } catch (error) {
      this.logger.error(`Error checking task status ${taskId}:`, error);
      throw new Error(`Failed to check task status: ${error.message}`);
    }
  }

  async getAccountInfo() {
    try {
      const response = await axios.get('https://api.dataforseo.com/v3/user', {
        headers: {
          'Authorization': `Basic ${this.auth}`,
        },
        timeout: 15000
      });

      return response.data;

    } catch (error) {
      this.logger.error('Error getting account info:', error);
      throw new Error(`Failed to get account info: ${error.message}`);
    }
  }
}

module.exports = DataForSEOClient;


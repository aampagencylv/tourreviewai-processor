# Hybrid Review System - Deployment Guide

## 🚀 **Quick Deployment to Railway (Recommended)**

### Step 1: Prepare Repository
```bash
# Create new GitHub repository
git init
git add .
git commit -m "Initial hybrid review system"
git remote add origin https://github.com/yourusername/tourreviewai-processor.git
git push -u origin main
```

### Step 2: Deploy to Railway
1. **Go to**: https://railway.app
2. **Click**: "Deploy from GitHub repo"
3. **Select**: Your repository
4. **Configure Environment Variables**:
   ```
   SUPABASE_URL=https://gzoklzhxnfogmtlkdnhp.supabase.co
   SUPABASE_SERVICE_ROLE_KEY=your_service_role_key
   DATAFORSEO_USERNAME=your_dataforseo_username
   DATAFORSEO_PASSWORD=your_dataforseo_password
   ALLOWED_ORIGINS=https://your-app.vercel.app
   ```
5. **Click**: "Deploy"

### Step 3: Update Supabase Function
1. **Deploy the trigger function**:
   ```bash
   # Set your processing service URL
   export PROCESSING_SERVICE_URL=https://your-app.railway.app
   
   # Deploy the bridge function
   supabase functions deploy trigger-import --project-ref gzoklzhxnfogmtlkdnhp
   ```

### Step 4: Test the System
```bash
# Test the processing service health
curl https://your-app.railway.app/health

# Test import via Supabase function
curl -X POST "https://gzoklzhxnfogmtlkdnhp.supabase.co/functions/v1/trigger-import" \
  -H "Authorization: Bearer YOUR_USER_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "platform": "tripadvisor",
    "url": "https://www.tripadvisor.com/Attraction_Review-g45963-d14068149-Reviews-Vegas_Jeep_Tours-Las_Vegas_Nevada.html",
    "fullHistory": true
  }'
```

## 🔧 **Alternative Deployment Options**

### Option 2: Render
1. **Connect GitHub repo** to Render
2. **Set build command**: `npm install`
3. **Set start command**: `npm start`
4. **Add environment variables** (same as Railway)

### Option 3: DigitalOcean App Platform
1. **Create new app** from GitHub
2. **Configure build settings**:
   - Build Command: `npm install`
   - Run Command: `npm start`
3. **Add environment variables**

### Option 4: Docker Deployment
```bash
# Build image
docker build -t tourreviewai-processor .

# Run container
docker run -d \
  --name tourreviewai-processor \
  -p 3001:3001 \
  --env-file .env \
  tourreviewai-processor
```

## 📊 **Environment Variables Reference**

### Required Variables
```bash
# Supabase
SUPABASE_URL=https://gzoklzhxnfogmtlkdnhp.supabase.co
SUPABASE_SERVICE_ROLE_KEY=your_service_role_key

# DataForSEO
DATAFORSEO_USERNAME=your_username
DATAFORSEO_PASSWORD=your_password

# Security
ALLOWED_ORIGINS=https://your-app.vercel.app,http://localhost:3000
```

### Optional Variables
```bash
# Performance Tuning
MAX_CONCURRENT_JOBS=5
BATCH_SIZE=100
POLL_INTERVAL=30000
MAX_RETRIES=3

# Monitoring
NODE_ENV=production
LOG_LEVEL=info
```

## 🧪 **Testing Your Deployment**

### Health Check
```bash
curl https://your-service.railway.app/health
```
Expected response:
```json
{
  "status": "healthy",
  "timestamp": "2025-01-01T00:00:00.000Z",
  "version": "1.0.0",
  "uptime": 123.45
}
```

### Processing Stats
```bash
curl https://your-service.railway.app/api/stats
```

### Manual Job Processing
```bash
curl -X POST https://your-service.railway.app/api/process/pending
```

## 🔄 **Integration with Frontend**

### Update Your React App
```typescript
// In your React component
const startImport = async (tripadvisorUrl: string) => {
  try {
    const response = await supabase.functions.invoke('trigger-import', {
      body: {
        platform: 'tripadvisor',
        url: tripadvisorUrl,
        fullHistory: true
      }
    })

    if (response.error) throw response.error

    const { job_id, business_name, estimated_completion_minutes } = response.data
    
    // Show success message
    toast.success(`Import started for ${business_name}! Estimated completion: ${estimated_completion_minutes} minutes`)
    
    // Start polling for progress
    pollJobProgress(job_id)
    
  } catch (error) {
    toast.error(`Import failed: ${error.message}`)
  }
}

const pollJobProgress = (jobId: string) => {
  const subscription = supabase
    .channel('job_updates')
    .on('postgres_changes', {
      event: 'UPDATE',
      schema: 'public',
      table: 'review_sync_jobs',
      filter: `id=eq.${jobId}`
    }, (payload) => {
      const job = payload.new
      updateJobProgress(job)
      
      if (['succeeded', 'failed', 'cancelled'].includes(job.status)) {
        subscription.unsubscribe()
      }
    })
    .subscribe()
}
```

## 📈 **Monitoring and Maintenance**

### Log Monitoring
- **Railway**: Built-in logs in dashboard
- **Render**: Logs tab in service dashboard
- **DigitalOcean**: App logs in control panel

### Performance Monitoring
```bash
# Check processing stats
curl https://your-service.railway.app/api/stats

# Monitor specific job
curl https://your-service.railway.app/api/job/JOB_ID/status
```

### Automatic Scaling
- **Railway**: Auto-scales based on CPU/memory
- **Render**: Configure auto-scaling in dashboard
- **DigitalOcean**: Set scaling rules in app settings

## 🎯 **Expected Performance**

### Light Usage (1-5 businesses)
- **Cost**: $5/month (Railway Starter)
- **Performance**: 1000+ reviews in 5-10 minutes
- **Reliability**: 99%+ success rate

### Medium Usage (5-20 businesses)
- **Cost**: $20/month (Railway Pro)
- **Performance**: 5000+ reviews in 15-20 minutes
- **Concurrent jobs**: 5+ simultaneous

### Heavy Usage (20+ businesses)
- **Cost**: $48/month (DigitalOcean)
- **Performance**: 10,000+ reviews in 30-45 minutes
- **Concurrent jobs**: 10+ simultaneous

## ✅ **Deployment Checklist**

- [ ] Repository created and pushed to GitHub
- [ ] Service deployed to hosting platform
- [ ] Environment variables configured
- [ ] Health check endpoint responding
- [ ] Supabase bridge function deployed
- [ ] Processing service URL configured in Supabase
- [ ] Test import completed successfully
- [ ] Real-time progress updates working
- [ ] Error handling and notifications working
- [ ] Monitoring and logging configured

## 🚨 **Troubleshooting**

### Common Issues
1. **Service won't start**: Check environment variables
2. **DataForSEO errors**: Verify credentials and account balance
3. **Database connection fails**: Check Supabase service role key
4. **Import hangs**: Check DataForSEO task status manually
5. **No progress updates**: Verify Supabase realtime is enabled

### Support
- Check service logs for detailed error messages
- Test individual components (health check, DataForSEO, database)
- Verify all environment variables are set correctly
- Ensure Supabase RLS policies allow the service to access tables

Your hybrid system is now ready to handle enterprise-scale review imports with professional reliability!


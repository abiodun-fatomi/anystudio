-- How a published post is doing, as the platform last reported it.
ALTER TABLE "publish_jobs" ADD COLUMN "metrics" JSONB, ADD COLUMN "metricsAt" TIMESTAMP(3);

-- Careers: openings and applications.

CREATE TYPE "JobType" AS ENUM ('FULL_TIME', 'PART_TIME', 'CONTRACT', 'INTERNSHIP');
CREATE TYPE "JobStatus" AS ENUM ('DRAFT', 'OPEN', 'CLOSED');
CREATE TYPE "ApplicationStatus" AS ENUM ('NEW', 'REVIEWING', 'INTERVIEW', 'OFFER', 'HIRED', 'REJECTED');

CREATE TABLE "job_postings" (
    "id" UUID NOT NULL,
    "slug" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "team" TEXT NOT NULL,
    "location" TEXT NOT NULL,
    "remote" BOOLEAN NOT NULL DEFAULT true,
    "type" "JobType" NOT NULL DEFAULT 'FULL_TIME',
    "summary" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "salary" TEXT,
    "status" "JobStatus" NOT NULL DEFAULT 'DRAFT',
    "publishedAt" TIMESTAMP(3),
    "closedAt" TIMESTAMP(3),
    "createdById" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "job_postings_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "job_postings_slug_key" ON "job_postings"("slug");
CREATE INDEX "job_postings_status_publishedAt_idx" ON "job_postings"("status", "publishedAt");

CREATE TABLE "job_applications" (
    "id" UUID NOT NULL,
    "jobId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "phone" TEXT,
    "links" TEXT,
    "coverNote" TEXT,
    "cvKey" TEXT,
    "cvName" TEXT,
    "status" "ApplicationStatus" NOT NULL DEFAULT 'NEW',
    "notes" TEXT,
    "ip" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "job_applications_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "job_applications_jobId_status_createdAt_idx" ON "job_applications"("jobId", "status", "createdAt");
CREATE INDEX "job_applications_email_idx" ON "job_applications"("email");
ALTER TABLE "job_applications" ADD CONSTRAINT "job_applications_jobId_fkey"
  FOREIGN KEY ("jobId") REFERENCES "job_postings"("id") ON DELETE CASCADE ON UPDATE CASCADE;

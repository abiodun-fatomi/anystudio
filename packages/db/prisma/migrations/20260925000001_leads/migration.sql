-- Platform enquiries from the /org contact form, every field kept.
CREATE TABLE "leads" (
    "id" UUID NOT NULL,
    "organization" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "role" TEXT,
    "volume" TEXT,
    "timeline" TEXT,
    "notes" TEXT,
    "source" TEXT NOT NULL DEFAULT 'org-contact',
    "ip" TEXT,
    "handledAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "leads_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "leads_createdAt_idx" ON "leads"("createdAt");

-- The mobile-app waitlist.
CREATE TABLE "waitlist_signups" (
    "id" UUID NOT NULL,
    "email" TEXT NOT NULL,
    "source" TEXT NOT NULL DEFAULT 'mobile',
    "ip" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "waitlist_signups_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "waitlist_signups_email_source_key" ON "waitlist_signups"("email", "source");

-- A customer can ask for a purchase back; staff decide, and approval refunds at the gateway.

CREATE TYPE "RefundRequestStatus" AS ENUM ('REQUESTED', 'APPROVED', 'REFUSED', 'CANCELLED');

CREATE TABLE "refund_requests" (
    "id" UUID NOT NULL,
    "paymentId" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "requestedById" UUID NOT NULL,
    "reason" TEXT NOT NULL,
    "status" "RefundRequestStatus" NOT NULL DEFAULT 'REQUESTED',
    "balanceAtRequest" INTEGER NOT NULL,
    "decidedById" UUID,
    "decidedAt" TIMESTAMP(3),
    "decisionNote" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "refund_requests_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "refund_requests_paymentId_key" ON "refund_requests"("paymentId");
CREATE INDEX "refund_requests_status_createdAt_idx" ON "refund_requests"("status", "createdAt");
CREATE INDEX "refund_requests_workspaceId_idx" ON "refund_requests"("workspaceId");
ALTER TABLE "refund_requests" ADD CONSTRAINT "refund_requests_paymentId_fkey"
  FOREIGN KEY ("paymentId") REFERENCES "payments"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "refund_requests" ADD CONSTRAINT "refund_requests_workspaceId_fkey"
  FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

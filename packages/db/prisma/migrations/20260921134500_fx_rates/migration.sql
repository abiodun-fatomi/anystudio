-- CreateTable
CREATE TABLE "fx_rates" (
    "currency" TEXT NOT NULL,
    "rate" DECIMAL(12,4) NOT NULL,
    "note" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "fx_rates_pkey" PRIMARY KEY ("currency")
);

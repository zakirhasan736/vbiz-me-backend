-- Package one-time signup fee (cents). Corporate negotiated monthly lives on Subscription.
ALTER TABLE "Package" ADD COLUMN "signupFeeCents" INTEGER NOT NULL DEFAULT 0;

ALTER TABLE "Subscription" ADD COLUMN "negotiatedMonthlyCents" INTEGER;
ALTER TABLE "Subscription" ADD COLUMN "signupFeeChargedAt" TIMESTAMP(3);

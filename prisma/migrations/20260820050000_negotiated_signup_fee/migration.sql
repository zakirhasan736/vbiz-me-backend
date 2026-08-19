-- Per-Corporate one-time signup fee. Null inherits Package.signupFeeCents.
ALTER TABLE "Subscription" ADD COLUMN "negotiatedSignupFeeCents" INTEGER;

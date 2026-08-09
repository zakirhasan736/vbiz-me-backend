-- CreateEnum
CREATE TYPE "AccountStatus" AS ENUM ('ACTIVE', 'PAUSED', 'SUSPENDED');

-- AlterTable
ALTER TABLE "User" ADD COLUMN "accountStatus" "AccountStatus" NOT NULL DEFAULT 'ACTIVE';
ALTER TABLE "User" ADD COLUMN "companyName" TEXT;

-- Backfill from existing isActive flags
UPDATE "User"
SET "accountStatus" = CASE WHEN "isActive" THEN 'ACTIVE'::"AccountStatus" ELSE 'PAUSED'::"AccountStatus" END;

-- Keep isActive in sync with accountStatus
UPDATE "User"
SET "isActive" = ("accountStatus" = 'ACTIVE' AND "deletedAt" IS NULL);

-- CreateEnum
CREATE TYPE "UserRole" AS ENUM ('vcard-owner', 'corporate-owner', 'admin');

-- AlterTable
ALTER TABLE "User" ADD COLUMN "role" "UserRole" NOT NULL DEFAULT 'vcard-owner';

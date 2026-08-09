-- AlterEnum
ALTER TYPE "UserRole" ADD VALUE 'super-admin';

-- AlterTable
ALTER TABLE "User" ADD COLUMN "staffRole" TEXT;
ALTER TABLE "User" ADD COLUMN "allowedModules" TEXT[] DEFAULT ARRAY[]::TEXT[];

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "isActive" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "isVerified" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "otpCode" INTEGER,
ADD COLUMN     "otpCoolDown" TIMESTAMP(3),
ADD COLUMN     "passwordChangedAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "ForgotPasswordToken" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ForgotPasswordToken_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ForgotPasswordToken_userId_idx" ON "ForgotPasswordToken"("userId");

-- AddForeignKey
ALTER TABLE "ForgotPasswordToken" ADD CONSTRAINT "ForgotPasswordToken_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

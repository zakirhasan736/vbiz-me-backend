import os
import sys
from datetime import datetime, timezone

import boto3
import psycopg2
from dotenv import load_dotenv
from psycopg2.extras import RealDictCursor

load_dotenv(".env")

APPLY = "--apply" in sys.argv

BUCKET = "aws-s3-vbizme-vcard"
REGION = "us-east-2"

TARGET_ATTACHMENT_LEGACY = 858
TARGET_PORTFOLIO_LEGACY = 125

SOURCE_KEY = (
    "vbizme/portfolio/"
    "cmsuupd8y05ymcnkclw08mcvy/"
    "Logo-Transparency.png"
)

EXPECTED_NAME = "Logo-Transparency.png"
EXPECTED_BYTES = 277032

dburl = os.getenv("DATABASE_URL")
if not dburl:
    raise RuntimeError("DATABASE_URL missing")

dburl = dburl.split("?")[0]

s3 = boto3.client(
    "s3",
    region_name=REGION,
    aws_access_key_id=os.getenv("AWS_ACCESS_KEY_ID"),
    aws_secret_access_key=os.getenv("AWS_SECRET_ACCESS_KEY"),
)

pg = psycopg2.connect(dburl)

try:
    with pg.cursor(cursor_factory=RealDictCursor) as c:

        # -------------------------------------------------------
        # Validate target portfolio
        # -------------------------------------------------------

        c.execute("""
            SELECT
                id,
                "legacyId",
                title,
                "profileId",
                "imageUrl",
                "attachmentUrl",
                "attachmentName"
            FROM "Portfolio"
            WHERE "legacyId" = %s
        """, (TARGET_PORTFOLIO_LEGACY,))

        portfolio = c.fetchone()

        if not portfolio:
            raise RuntimeError("Target Portfolio 125 not found")

        if portfolio["title"] != "Rango Spader":
            raise RuntimeError(
                f'Unexpected Portfolio title: {portfolio["title"]!r}'
            )

        # -------------------------------------------------------
        # Validate attachment 858
        # -------------------------------------------------------

        c.execute("""
            SELECT
                id,
                "legacyId",
                "attachableId",
                "attachableType",
                "docName",
                url,
                "publicId",
                bytes
            FROM "Attachment"
            WHERE "legacyId" = %s
        """, (TARGET_ATTACHMENT_LEGACY,))

        attachment = c.fetchone()

        if not attachment:
            raise RuntimeError("Attachment 858 not found")

        if attachment["attachableId"] != portfolio["id"]:
            raise RuntimeError(
                "Attachment 858 is not linked to Portfolio 125"
            )

        if attachment["docName"] != EXPECTED_NAME:
            raise RuntimeError(
                f'Unexpected filename: {attachment["docName"]!r}'
            )

        # -------------------------------------------------------
        # Validate proven S3 source
        # -------------------------------------------------------

        head = s3.head_object(
            Bucket=BUCKET,
            Key=SOURCE_KEY,
        )

        actual_bytes = head["ContentLength"]

        if actual_bytes != EXPECTED_BYTES:
            raise RuntimeError(
                f"S3 size mismatch: {actual_bytes} != {EXPECTED_BYTES}"
            )

        # -------------------------------------------------------
        # Destination
        # -------------------------------------------------------

        target_key = (
            f'vbizme/portfolio/{portfolio["id"]}/'
            f'{EXPECTED_NAME}'
        )

        target_url = (
            f"https://{BUCKET}.s3.{REGION}.amazonaws.com/"
            f"{target_key}"
        )

        print("=" * 100)
        print("MICHAELANGELO FEATURED IMAGE 858 REPAIR")
        print("=" * 100)

        print("Portfolio legacy :", TARGET_PORTFOLIO_LEGACY)
        print("Portfolio ID     :", portfolio["id"])
        print("Title            :", portfolio["title"])

        print()
        print("Attachment legacy:", TARGET_ATTACHMENT_LEGACY)
        print("Filename         :", EXPECTED_NAME)

        print()
        print("SOURCE KEY       :", SOURCE_KEY)
        print("SOURCE BYTES     :", actual_bytes)

        print()
        print("TARGET KEY       :", target_key)
        print("TARGET URL       :", target_url)

        if not APPLY:
            print()
            print("DRY RUN — NOTHING CHANGED")
            pg.rollback()
            sys.exit(0)

        # -------------------------------------------------------
        # Copy S3 object
        # -------------------------------------------------------

        s3.copy_object(
            Bucket=BUCKET,
            CopySource={
                "Bucket": BUCKET,
                "Key": SOURCE_KEY,
            },
            Key=target_key,
            ContentType="image/png",
            MetadataDirective="REPLACE",
        )

        # Validate copied object
        copied = s3.head_object(
            Bucket=BUCKET,
            Key=target_key,
        )

        if copied["ContentLength"] != EXPECTED_BYTES:
            raise RuntimeError("Copied S3 object size mismatch")

        now = datetime.now(timezone.utc)

        # -------------------------------------------------------
        # Update attachment
        # -------------------------------------------------------

        c.execute("""
            UPDATE "Attachment"
            SET
                url = %s,
                "publicId" = %s,
                "resourceType" = 'image',
                format = 'png',
                bytes = %s,
                extension = 'png',
                "mimeType" = 'image/png',
                "updatedAt" = %s
            WHERE "legacyId" = %s
        """, (
            target_url,
            target_key,
            EXPECTED_BYTES,
            now,
            TARGET_ATTACHMENT_LEGACY,
        ))

        if c.rowcount != 1:
            raise RuntimeError(
                f"Expected to update 1 attachment, updated {c.rowcount}"
            )

        # -------------------------------------------------------
        # Featured Image => Portfolio image fields
        # -------------------------------------------------------

        c.execute("""
            UPDATE "Portfolio"
            SET
                "imageUrl" = %s,
                "attachmentUrl" = %s,
                "attachmentName" = %s,
                "updatedAt" = %s
            WHERE id = %s
        """, (
            target_url,
            target_url,
            EXPECTED_NAME,
            now,
            portfolio["id"],
        ))

        if c.rowcount != 1:
            raise RuntimeError("Portfolio update failed")

        pg.commit()

        print()
        print("COMMITTED SUCCESSFULLY")

except Exception:
    pg.rollback()
    raise

finally:
    pg.close()

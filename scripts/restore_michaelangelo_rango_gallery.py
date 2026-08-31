import os
import sys
import uuid
from datetime import datetime, timezone
from urllib.parse import urlparse

import boto3
import psycopg2
from dotenv import load_dotenv
from psycopg2.extras import RealDictCursor

load_dotenv(".env")

APPLY = "--apply" in sys.argv

PROFILE_ID = "cmsuup13204ubcnkcdd5m3dgy"
PORTFOLIO_LEGACY_ID = 125
ATTACHMENT_LEGACY_ID = 1013

SOURCE_ATTACHMENT_LEGACY_ID = 1054

EXPECTED_DOC_NAME = "Rango Spader.jpeg"
EXPECTED_BYTES = 179924

BUCKET = "aws-s3-vbizme-vcard"
REGION = "us-east-2"

database_url = os.getenv("DATABASE_URL")
if not database_url:
    raise RuntimeError("DATABASE_URL missing from .env")

database_url = database_url.split("?")[0]

s3 = boto3.client(
    "s3",
    region_name=REGION,
)

pg = psycopg2.connect(database_url)

try:
    with pg.cursor(cursor_factory=RealDictCursor) as c:

        # ------------------------------------------------------------------
        # 1. Validate target Portfolio
        # ------------------------------------------------------------------
        c.execute("""
            SELECT
                id,
                "legacyId",
                "profileId",
                title
            FROM "Portfolio"
            WHERE "legacyId" = %s
              AND "profileId" = %s
        """, (PORTFOLIO_LEGACY_ID, PROFILE_ID))

        portfolio = c.fetchone()

        if not portfolio:
            raise RuntimeError("Target Portfolio 125 not found")

        if portfolio["title"] != "Rango Spader":
            raise RuntimeError(
                f'Unexpected Portfolio title: {portfolio["title"]}'
            )

        # ------------------------------------------------------------------
        # 2. Make sure attachment 1013 does NOT already exist
        # ------------------------------------------------------------------
        c.execute("""
            SELECT *
            FROM "Attachment"
            WHERE "legacyId" = %s
        """, (ATTACHMENT_LEGACY_ID,))

        existing = c.fetchone()

        if existing:
            raise RuntimeError(
                "Attachment 1013 already exists. Nothing will be inserted."
            )

        # ------------------------------------------------------------------
        # 3. Load proven source Attachment 1054
        # ------------------------------------------------------------------
        c.execute("""
            SELECT
                id,
                "legacyId",
                "docName",
                url,
                "publicId",
                bytes,
                "resourceType",
                format,
                extension,
                "mimeType"
            FROM "Attachment"
            WHERE "legacyId" = %s
        """, (SOURCE_ATTACHMENT_LEGACY_ID,))

        source = c.fetchone()

        if not source:
            raise RuntimeError("Source Attachment 1054 not found")

        if source["docName"] != EXPECTED_DOC_NAME:
            raise RuntimeError(
                f'Source docName mismatch: {source["docName"]}'
            )

        if source["bytes"] != EXPECTED_BYTES:
            raise RuntimeError(
                f'Source size mismatch: {source["bytes"]}'
            )

        if not source["publicId"]:
            raise RuntimeError("Source Attachment has no S3 publicId")

        source_key = source["publicId"]

        # ------------------------------------------------------------------
        # 4. Verify actual S3 source object
        # ------------------------------------------------------------------
        head = s3.head_object(
            Bucket=BUCKET,
            Key=source_key,
        )

        actual_bytes = head["ContentLength"]

        if actual_bytes != EXPECTED_BYTES:
            raise RuntimeError(
                f"S3 source size mismatch: {actual_bytes}"
            )

        # ------------------------------------------------------------------
        # 5. Build target S3 key
        # ------------------------------------------------------------------
        safe_filename = "Rango-Spader.jpeg"

        target_key = (
            f'vbizme/portfolio/'
            f'{portfolio["id"]}/'
            f'{safe_filename}'
        )

        target_url = (
            f"https://{BUCKET}.s3.{REGION}.amazonaws.com/"
            f"{target_key}"
        )

        print("=" * 100)
        print("MICHAELANGELO RANGO GALLERY RESTORE")
        print("=" * 100)

        print("TARGET PORTFOLIO ID      :", portfolio["id"])
        print("TARGET PORTFOLIO LEGACY  :", portfolio["legacyId"])
        print("TARGET TITLE             :", portfolio["title"])
        print()

        print("SOURCE ATTACHMENT LEGACY :", source["legacyId"])
        print("SOURCE DOC NAME          :", source["docName"])
        print("SOURCE S3 KEY            :", source_key)
        print("SOURCE BYTES             :", actual_bytes)
        print()

        print("NEW ATTACHMENT LEGACY    :", ATTACHMENT_LEGACY_ID)
        print("TARGET S3 KEY            :", target_key)
        print("TARGET URL               :", target_url)
        print()

        if not APPLY:
            print("DRY RUN — NOTHING CHANGED")
            pg.rollback()
            raise SystemExit(0)

        # ------------------------------------------------------------------
        # 6. Copy proven S3 object into Portfolio 125 folder
        # ------------------------------------------------------------------
        s3.copy_object(
            Bucket=BUCKET,
            CopySource={
                "Bucket": BUCKET,
                "Key": source_key,
            },
            Key=target_key,
            ContentType="image/jpeg",
            MetadataDirective="REPLACE",
        )

        # Verify copied object
        copied = s3.head_object(
            Bucket=BUCKET,
            Key=target_key,
        )

        if copied["ContentLength"] != EXPECTED_BYTES:
            raise RuntimeError(
                "Copied S3 object failed size validation"
            )

        # ------------------------------------------------------------------
        # 7. Insert Attachment 1013
        # ------------------------------------------------------------------
        new_attachment_id = "c" + uuid.uuid4().hex[:24]

        now = datetime.now(timezone.utc)

        c.execute("""
            INSERT INTO "Attachment" (
                id,
                "legacyId",
                "attachableId",
                "attachableType",
                "docName",
                url,
                "publicId",
                "resourceType",
                format,
                bytes,
                extension,
                "mimeType",
                "createdAt",
                "updatedAt"
            )
            VALUES (
                %s, %s, %s, %s, %s,
                %s, %s, %s, %s, %s,
                %s, %s, %s, %s
            )
        """, (
            new_attachment_id,
            ATTACHMENT_LEGACY_ID,
            portfolio["id"],
            "Portfolio",
            EXPECTED_DOC_NAME,
            target_url,
            target_key,
            "image",
            "jpeg",
            EXPECTED_BYTES,
            "jpeg",
            "image/jpeg",
            now,
            now,
        ))

        if c.rowcount != 1:
            raise RuntimeError("Attachment 1013 insert failed")

        pg.commit()

        print()
        print("COMMITTED SUCCESSFULLY")
        print("NEW ATTACHMENT ID:", new_attachment_id)

except SystemExit:
    raise

except Exception:
    pg.rollback()
    raise

finally:
    pg.close()

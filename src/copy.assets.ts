import fs from 'fs-extra'

async function copyAssets() {
  await fs.copy('src/templates', 'dist/templates')
  await fs.copy('src/assets/email', 'dist/assets/email')
}

copyAssets()

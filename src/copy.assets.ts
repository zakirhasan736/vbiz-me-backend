import fs from 'fs-extra'

async function copyTemplates() {
  await fs.copy('src/templates', 'dist/templates')
}

copyTemplates()

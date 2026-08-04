import jwt, { type SignOptions } from 'jsonwebtoken'
import config from '../configs/config'

export default {
  generateAccessToken: (payload: object) => {
    const { EXPIRY, SECRET = '' } = config.ACCESS_TOKEN
    return jwt.sign(payload, SECRET, { expiresIn: EXPIRY as SignOptions['expiresIn'] })
  },
  generateRefreshToken: (id: string) => {
    const { EXPIRY, SECRET = '' } = config.REFRESH_TOKEN
    return jwt.sign({ id }, SECRET, { expiresIn: EXPIRY as SignOptions['expiresIn'] })
  },
  verifyAccessToken: (token: string) => {
    const { SECRET = '' } = config.ACCESS_TOKEN
    return jwt.verify(token, SECRET)
  },
  verifyRefreshToken: (token: string) => {
    const { SECRET = '' } = config.REFRESH_TOKEN
    return jwt.verify(token, SECRET)
  },
  getDomainFromUrl: (url: string) => {
    const parsedUrl = new URL(url)
    return parsedUrl.hostname
  },
}

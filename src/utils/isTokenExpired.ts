import jwt, { type JwtPayload } from 'jsonwebtoken'

const isTokenExpired = (token: string) => {
  if (!token) {
    return true
  }
  const decodedToken = jwt.decode(token) as JwtPayload | null
  if (!decodedToken?.exp) {
    return true
  }
  const currentTime = Date.now() / 1000
  return decodedToken.exp < currentTime
}

export default isTokenExpired

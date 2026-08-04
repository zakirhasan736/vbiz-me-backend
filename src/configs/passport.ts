import passport from 'passport'
import { Profile as FacebookProfile, Strategy as FacebookStrategy } from 'passport-facebook'
import { Profile as GoogleProfile, Strategy as GoogleStrategy } from 'passport-google-oauth20'
import authService from '../services/auth.service'
import config from './config'

if (config.GOOGLE_CLIENT_ID && config.GOOGLE_CLIENT_SECRET) {
  passport.use(
    new GoogleStrategy(
      {
        clientID: config.GOOGLE_CLIENT_ID,
        clientSecret: config.GOOGLE_CLIENT_SECRET,
        callbackURL: `${config.SERVER_URL}/api/v1/auth/google/callback`,
      },
      async (_accessToken, _refreshToken, profile: GoogleProfile, done) => {
        try {
          const email = profile.emails?.[0]?.value || profile._json.email
          if (!email) {
            return done(new Error('Google account email is required'))
          }

          const result = await authService.findOrCreateSocialUser({
            email,
            name: profile.displayName || profile._json.name || null,
            avatar: profile.photos?.[0]?.value || profile._json.picture || null,
            provider: 'GOOGLE',
            providerId: profile.id,
          })

          return done(null, {
            user: result.user,
            accessToken: result.accessToken,
            refreshToken: result.refreshToken,
            provider: 'google',
          })
        } catch (error) {
          return done(error as Error)
        }
      }
    )
  )
}

if (config.FACEBOOK_APP_ID && config.FACEBOOK_APP_SECRET) {
  passport.use(
    new FacebookStrategy(
      {
        clientID: config.FACEBOOK_APP_ID,
        clientSecret: config.FACEBOOK_APP_SECRET,
        callbackURL: `${config.SERVER_URL}/api/v1/auth/facebook/callback`,
        profileFields: ['id', 'displayName', 'emails', 'photos'],
      },
      async (_accessToken, _refreshToken, profile: FacebookProfile, done) => {
        try {
          const email = profile.emails?.[0]?.value || (profile._json as { email?: string }).email
          if (!email) {
            return done(new Error('Facebook account email is required'))
          }

          const result = await authService.findOrCreateSocialUser({
            email,
            name: profile.displayName || null,
            avatar: profile.photos?.[0]?.value || null,
            provider: 'FACEBOOK',
            providerId: profile.id,
          })

          return done(null, {
            user: result.user,
            accessToken: result.accessToken,
            refreshToken: result.refreshToken,
            provider: 'facebook',
          })
        } catch (error) {
          return done(error as Error)
        }
      }
    )
  )
}

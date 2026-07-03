import { Injectable } from "@nestjs/common";
import { PassportStrategy } from "@nestjs/passport";
import { Strategy, type Profile, type VerifyCallback } from "passport-google-oauth20";
import { ConfigService } from "@nestjs/config";

export interface GoogleProfile {
  googleId: string;
  email: string;
  name: string | undefined;
}

@Injectable()
export class GoogleStrategy extends PassportStrategy(Strategy, "google") {
  constructor(config: ConfigService) {
    super({
      clientID: config.get<string>("GOOGLE_CLIENT_ID", ""),
      clientSecret: config.get<string>("GOOGLE_CLIENT_SECRET", ""),
      callbackURL: config.get<string>("GOOGLE_CALLBACK_URL", ""),
      scope: ["email", "profile"],
    });
  }

  validate(
    _accessToken: string,
    _refreshToken: string,
    profile: Profile,
    done: VerifyCallback,
  ): void {
    const email = profile.emails?.[0]?.value;
    if (!email) {
      done(new Error("No email returned from Google profile"), undefined);
      return;
    }
    done(null, { googleId: profile.id, email, name: profile.displayName } satisfies GoogleProfile);
  }
}

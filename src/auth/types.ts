export interface OAuthCredentials {
  readonly access_token: string;
  readonly refresh_token: string;
  readonly expiry_date: number;
  readonly token_type: string;
  readonly scope: string;
  readonly apiKey: string;
  readonly userId: string;
  readonly userName: string;
  readonly avatar: string;
  readonly email: string;
  readonly phone: string;
}

export interface TokenResponse {
  readonly access_token: string;
  readonly refresh_token: string;
  readonly expires_in: number;
  readonly token_type: string;
  readonly scope: string;
}

export interface UserInfoResponse {
  readonly apiKey: string;
  readonly userId: string;
  readonly userName: string;
  readonly avatar: string;
  readonly email: string;
  readonly phone: string;
}

export interface AuthLogger {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

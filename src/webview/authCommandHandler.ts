import { AuthService } from '../authService';

export interface AuthCommandHandlerDeps {
  showInformationMessage(message: string): Thenable<string | undefined>;
  showErrorMessage(message: string): Thenable<string | undefined>;
  debug(message: string): void;
}

export class AuthCommandHandler {
  constructor(
    private readonly authService: AuthService,
    private readonly deps: AuthCommandHandlerDeps,
  ) {}

  async startAuth(): Promise<void> {
    try {
      this.deps.debug('Starting OAuth login flow');
      await this.authService.startLogin();
      await this.deps.showInformationMessage('iFlow: Login successful');
      this.deps.debug('OAuth login flow completed successfully');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.deps.debug(`OAuth login flow failed: ${message}`);
      await this.deps.showErrorMessage(`iFlow login failed: ${message}`);
    }
  }
}

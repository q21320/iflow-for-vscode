import * as vscode from 'vscode';
import { WebviewHandler } from './webviewHandler';

export class IFlowPanel {
  public static currentPanel: IFlowPanel | undefined;
  private static readonly viewType = 'iflowPanel';

  private readonly panel: vscode.WebviewPanel;
  private readonly handler: WebviewHandler;

  public static createOrShow(
    extensionUri: vscode.Uri,
    globalState: vscode.Memento,
    secrets: vscode.SecretStorage
  ): void {
    // If we already have a panel, show it
    if (IFlowPanel.currentPanel) {
      IFlowPanel.currentPanel.panel.reveal();
      return;
    }

    // Otherwise, create a new panel beside the current editor (right side)
    const panel = vscode.window.createWebviewPanel(
      IFlowPanel.viewType,
      'IFlow',
      vscode.ViewColumn.Beside,
      {
        enableScripts: true,
        enableCommandUris: ['workbench.action.openSettings'],
        retainContextWhenHidden: true,
        localResourceRoots: [
          vscode.Uri.joinPath(extensionUri, 'dist'),
          vscode.Uri.joinPath(extensionUri, 'media')
        ]
      }
    );

    IFlowPanel.currentPanel = new IFlowPanel(panel, extensionUri, globalState, secrets);

    // Auto-lock the editor group so the panel stays pinned
    setTimeout(() => {
      vscode.commands.executeCommand('workbench.action.lockEditorGroup');
    }, 300);
  }

  private constructor(
    panel: vscode.WebviewPanel,
    extensionUri: vscode.Uri,
    globalState: vscode.Memento,
    secrets: vscode.SecretStorage
  ) {
    this.panel = panel;

    // Set the panel tab icon to iflow_favicon.svg
    this.panel.iconPath = vscode.Uri.joinPath(extensionUri, 'media', 'iflow_favicon.svg');

    this.handler = new WebviewHandler(extensionUri, globalState, secrets);

    // Bind handler to this webview
    this.handler.bindWebview(panel.webview);

    // Set the webview's initial html content
    this.panel.webview.html = this.handler.getHtmlForWebview(panel.webview);

    // Listen for when the panel is disposed
    this.panel.onDidDispose(() => this.dispose());
  }

  public dispose(): void {
    IFlowPanel.currentPanel = undefined;

    // Full cleanup
    this.handler.dispose().catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`[IFlow] Failed to dispose panel handler: ${message}`);
    });

    // Clean up resources
    this.panel.dispose();
  }
}

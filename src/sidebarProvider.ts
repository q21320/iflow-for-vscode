import * as vscode from "vscode";
import { WebviewHandler } from "./webviewHandler";

export class IFlowSidebarProvider implements vscode.WebviewViewProvider {
  public static readonly primaryViewType = "iflow-sidebar";
  public static readonly secondaryViewType = "iflow-sidebar-secondary";

  private handler: WebviewHandler | null = null;
  private view: vscode.WebviewView | null = null;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly globalState: vscode.Memento,
  ) {}

  resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken,
  ): void {
    this.view = webviewView;

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [
        vscode.Uri.joinPath(this.extensionUri, "dist"),
        vscode.Uri.joinPath(this.extensionUri, "media"),
      ],
    };

    // Create handler for this sidebar view
    this.handler = new WebviewHandler(this.extensionUri, this.globalState);
    this.handler.bindWebview(webviewView.webview);

    // Set HTML content
    webviewView.webview.html = this.handler.getHtmlForWebview(
      webviewView.webview,
    );

    // Cleanup when view is disposed
    webviewView.onDidDispose(() => {
      this.handler?.dispose().catch((error) => {
        const message = error instanceof Error ? error.message : String(error);
        console.warn(`[IFlow] Failed to dispose sidebar handler: ${message}`);
      });
      this.handler = null;
      this.view = null;
    });
  }
}

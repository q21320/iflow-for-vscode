import * as vscode from "vscode";
import { IFlowPanel } from "./panel";
import { IFlowSidebarProvider } from "./sidebarProvider";

export function activate(context: vscode.ExtensionContext) {
  if (
    vscode.workspace
      .getConfiguration("iflow")
      .get<boolean>("debugLogging", false)
  ) {
    console.debug("[IFlow] Extension activated");
  }

  // Register the independent panel command
  const disposable = vscode.commands.registerCommand(
    "iflow-for-vscode.openPanel",
    () => {
      if (
        vscode.workspace
          .getConfiguration("iflow")
          .get<boolean>("debugLogging", false)
      ) {
        console.debug("[IFlow] Command invoked: iflow-for-vscode.openPanel");
      }
      IFlowPanel.createOrShow(context.extensionUri, context.globalState);
    },
  );
  context.subscriptions.push(disposable);

  // Register lock editor group command
  const lockDisposable = vscode.commands.registerCommand(
    "iflow-for-vscode.lockGroup",
    () => {
      if (
        vscode.workspace
          .getConfiguration("iflow")
          .get<boolean>("debugLogging", false)
      ) {
        console.debug("[IFlow] Command invoked: iflow-for-vscode.lockGroup");
      }
      vscode.commands.executeCommand("workbench.action.lockEditorGroup");
    },
  );
  context.subscriptions.push(lockDisposable);

  // Register both primary and secondary sidebar webview providers
  const registerSidebarView = (viewType: string) => {
    const sidebarProvider = new IFlowSidebarProvider(
      context.extensionUri,
      context.globalState,
    );
    const sidebarDisposable = vscode.window.registerWebviewViewProvider(
      viewType,
      sidebarProvider,
      { webviewOptions: { retainContextWhenHidden: true } },
    );
    context.subscriptions.push(sidebarDisposable);
  };

  registerSidebarView(IFlowSidebarProvider.primaryViewType);
  registerSidebarView(IFlowSidebarProvider.secondaryViewType);
}

export function deactivate() {}

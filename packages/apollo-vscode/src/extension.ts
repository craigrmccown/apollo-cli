import { join, resolve } from "path";
import {
  window,
  workspace,
  ExtensionContext,
  Uri,
  ProgressLocation,
  DecorationOptions,
  commands,
  QuickPickItem
} from "vscode";
import {
  LanguageClient,
  LanguageClientOptions,
  ServerOptions,
  TransportKind
} from "vscode-languageclient";
import StatusBar from "./StatusBar";

import { findAndLoadConfig } from "apollo/lib/config";

// Basically hijack the .env file so we have the values in process.env later
require("dotenv").config({
  ...(workspace.rootPath && { path: resolve(workspace.rootPath, ".env") })
});

export function activate(context: ExtensionContext) {
  const serverModule = context.asAbsolutePath(join("server", "server.js"));
  const debugOptions = { execArgv: ["--nolazy", "--inspect=6009"] };
  const schemaTags: QuickPickItem[] = [];

  workspace.findFiles("**/apollo.config.js").then(files => {
    if (files.length) {
      const config = findAndLoadConfig(files[0].path, true, true);
      const localDevUrl = (
        ((config || {}).schemas || {}).default.endpoint || {}
      ).url;

      if (localDevUrl) {
        schemaTags.push({
          label: "local",
          description: localDevUrl,
          detail: "test"
        });
      }
    }
  });

  const serverOptions: ServerOptions = {
    run: { module: serverModule, transport: TransportKind.ipc },
    debug: {
      module: serverModule,
      transport: TransportKind.ipc,
      options: debugOptions
    }
  };

  const clientOptions: LanguageClientOptions = {
    documentSelector: [
      "graphql",
      "javascript",
      "typescript",
      "javascriptreact",
      "typescriptreact"
    ],
    synchronize: {
      fileEvents: [
        workspace.createFileSystemWatcher("**/apollo.config.js"),
        workspace.createFileSystemWatcher("**/package.json"),
        workspace.createFileSystemWatcher("**/*.{graphql,js,ts,jsx,tsx}")
      ]
    }
  };

  const statusBar = new StatusBar();

  const client = new LanguageClient(
    "apollographql",
    "Apollo GraphQL",
    serverOptions,
    clientOptions
  );
  client.registerProposedFeatures();
  context.subscriptions.push(client.start());

  client.onReady().then(() => {
    client.onNotification("apollographql/tagsLoaded", stringifiedTags => {
      debugger;
      const tags = JSON.parse(stringifiedTags);
      schemaTags.push({ label: tags, description: "", detail: "" });
      statusBar.setTagsPopulated(true);

      commands.registerCommand("launchSchemaTagPicker", async () => {
        const selection = await window.showQuickPick(schemaTags);
        if (selection) {
          client.sendNotification("apollographql/tagSelected", selection);
        }
      });
    });

    let currentLoadingResolve: Map<number, () => void> = new Map();

    client.onNotification("apollographql/loadingComplete", token => {
      statusBar.showLoadedState();
      const inMap = currentLoadingResolve.get(token);
      if (inMap) {
        inMap();
        currentLoadingResolve.delete(token);
      }
    });

    client.onNotification("apollographql/loading", ({ message, token }) => {
      window.withProgress(
        {
          location: ProgressLocation.Notification,
          title: message,
          cancellable: false
        },
        () => {
          return new Promise(resolve => {
            currentLoadingResolve.set(token, resolve);
          });
        }
      );
    });

    const engineDecoration = window.createTextEditorDecorationType({});
    let latestDecs: any[] | undefined = undefined;

    const updateDecorations = () => {
      if (window.activeTextEditor && latestDecs) {
        const editor = window.activeTextEditor!;
        const decorations: DecorationOptions[] = latestDecs
          .filter(
            d => d.document === window.activeTextEditor!.document.uri.toString()
          )
          .map(dec => {
            return {
              range: editor.document.lineAt(dec.range.start.line).range,
              renderOptions: {
                after: {
                  contentText: `# ${dec.message}`,
                  textDecoration: "none; padding-left: 15px; opacity: 0.5"
                }
              }
            };
          });

        window.activeTextEditor!.setDecorations(engineDecoration, decorations);
      }
    };

    client.onNotification("apollographql/engineDecorations", (...decs) => {
      latestDecs = decs;
      updateDecorations();
    });

    window.onDidChangeActiveTextEditor(() => {
      updateDecorations();
    });

    workspace.registerTextDocumentContentProvider("graphql-schema", {
      provideTextDocumentContent(uri: Uri) {
        // the schema source is provided inside the URI, just return that here
        return uri.query;
      }
    });
  });
}

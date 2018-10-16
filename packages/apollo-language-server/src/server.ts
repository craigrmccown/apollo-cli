import {
  createConnection,
  ProposedFeatures,
  TextDocuments,
  FileChangeType,
  NotificationType
} from "vscode-languageserver";

import { GraphQLWorkspace } from "./workspace";
import { GraphQLLanguageProvider } from "./languageProvider";

import { execute, DocumentNode } from "apollo-link";
import { createHttpLink } from "apollo-link-http";
import fetch from "node-fetch";
import { OperationDefinitionNode } from "graphql";

import { WebSocketLink } from "apollo-link-ws";
import { SubscriptionClient } from "subscriptions-transport-ws";

import Uri from "vscode-uri";

import * as ws from "ws";

import { dirname } from "path";
import { findAndLoadConfig } from "@craigrmccown/apollo/lib/config";

const connection = createConnection(ProposedFeatures.all);

let hasWorkspaceFolderCapability = false;

export class LoadingHandler {
  private latestLoadingToken = 0;
  async handle<T>(message: string, value: Promise<T>): Promise<T> {
    const token = this.latestLoadingToken;
    this.latestLoadingToken += 1;
    connection.sendNotification(
      new NotificationType<any, void>("apollographql/loading"),
      { message, token }
    );

    try {
      const ret = await value;
      connection.sendNotification(
        new NotificationType<any, void>("apollographql/loadingComplete"),
        token
      );
      return ret;
    } catch (e) {
      connection.sendNotification(
        new NotificationType<any, void>("apollographql/loadingComplete"),
        token
      );
      connection.window.showErrorMessage(`Error in "${message}": ${e}`);
      throw e;
    }
  }

  handleSync<T>(message: string, value: () => T): T {
    const token = this.latestLoadingToken;
    this.latestLoadingToken += 1;
    connection.sendNotification(
      new NotificationType<any, void>("apollographql/loading"),
      { message, token }
    );

    try {
      const ret = value();
      connection.sendNotification(
        new NotificationType<any, void>("apollographql/loadingComplete"),
        token
      );
      return ret;
    } catch (e) {
      connection.sendNotification(
        new NotificationType<any, void>("apollographql/loadingComplete"),
        token
      );
      connection.window.showErrorMessage(`Error in "${message}": ${e}`);
      throw e;
    }
  }
}

const workspace = new GraphQLWorkspace(new LoadingHandler());

workspace.onDiagnostics(params => {
  connection.sendDiagnostics(params);
});

workspace.onDecorations(decs => {
  connection.sendNotification("apollographql/engineDecorations", decs);
});

const hasInitializedPromise = new Promise(resolve => {
  connection.onInitialized(async () => {
    resolve();

    if (hasWorkspaceFolderCapability) {
      connection.workspace.onDidChangeWorkspaceFolders(event => {
        event.removed.forEach(folder =>
          workspace.removeProjectsInFolder(folder)
        );
        event.added.forEach(folder => workspace.addProjectsInFolder(folder));
      });
    }
  });
});

connection.onInitialize(async params => {
  let capabilities = params.capabilities;
  hasWorkspaceFolderCapability = !!(
    capabilities.workspace && capabilities.workspace.workspaceFolders
  );

  const workspaceFolders = params.workspaceFolders;
  if (workspaceFolders) {
    hasInitializedPromise.then(() => {
      workspaceFolders.forEach(folder => workspace.addProjectsInFolder(folder));
    });
  }

  return {
    capabilities: {
      hoverProvider: true,
      definitionProvider: true,
      referencesProvider: true,
      completionProvider: {
        resolveProvider: false,
        triggerCharacters: ["..."]
      },
      codeLensProvider: {
        resolveProvider: false
      },
      executeCommandProvider: {
        commands: [
          "apollographql.runQuery",
          "apollographql.runQueryWithVariables"
        ]
      },
      textDocumentSync: documents.syncKind
    }
  };
});

const documents: TextDocuments = new TextDocuments();

// Make the text document manager listen on the connection
// for open, change and close text document events
documents.listen(connection);

documents.onDidChangeContent(params => {
  const project = workspace.projectForFile(params.document.uri);
  if (!project) return;

  project.documentDidChange(params.document);
});

connection.onDidChangeWatchedFiles(params => {
  for (const change of params.changes) {
    const uri = change.uri;

    const filePath = Uri.parse(change.uri).fsPath;
    if (
      filePath.endsWith("apollo.config.js") ||
      filePath.endsWith("package.json")
    ) {
      const projectForConfig = Array.from(
        workspace.projectsByFolderUri.values()
      )
        .flatMap(arr => arr)
        .find(proj => {
          return proj.configFile === filePath;
        });

      if (projectForConfig) {
        const newConfig = findAndLoadConfig(
          dirname(projectForConfig.configFile),
          false,
          true
        );

        if (newConfig) {
          projectForConfig.updateConfig(newConfig);
        }
      }
    }

    // Don't respond to changes in files that are currently open,
    // because we'll get content change notifications instead
    if (change.type === FileChangeType.Changed) {
      continue;
    }

    const project = workspace.projectForFile(uri);
    if (!project) continue;

    switch (change.type) {
      case FileChangeType.Created:
        project.fileDidChange(uri);
        break;
      case FileChangeType.Deleted:
        project.fileWasDeleted(uri);
        break;
    }
  }
});

const languageProvider = new GraphQLLanguageProvider(workspace);

connection.onHover((params, token) => {
  return languageProvider.provideHover(
    params.textDocument.uri,
    params.position,
    token
  );
});

connection.onDefinition((params, token) => {
  return languageProvider.provideDefinition(
    params.textDocument.uri,
    params.position,
    token
  );
});

connection.onReferences((params, token) => {
  return languageProvider.provideReferences(
    params.textDocument.uri,
    params.position,
    params.context,
    token
  );
});

connection.onCompletion((params, token) => {
  return languageProvider.provideCompletionItems(
    params.textDocument.uri,
    params.position,
    token
  );
});

connection.onCodeLens((params, token) => {
  return languageProvider.provideCodeLenses(params.textDocument.uri, token);
});

const createSubscriptionLink = (endpoint: string) => {
  const client = new SubscriptionClient(
    endpoint,
    {
      reconnect: true
    },
    ws
  );

  return new WebSocketLink(client);
};

const cancellationFunctions: { [id: number]: () => void } = {};
let nextCancellationID = 1;

export const executeAndNotify = (
  query: DocumentNode,
  endpoint: string,
  headers: any,
  variables: any
) => {
  const operation = query.definitions[0] as OperationDefinitionNode;
  const link =
    operation.operation === "subscription"
      ? createSubscriptionLink(endpoint)
      : createHttpLink({ uri: endpoint, fetch } as any);

  const cancellationID = nextCancellationID;
  nextCancellationID++;

  const sub = execute(link, {
    query,
    variables,
    context: { headers }
  }).subscribe(
    value => {
      connection.sendNotification(
        new NotificationType<any, void>("apollographql/queryResult"),
        { result: value, cancellationID }
      );
    },
    error => {
      if (error.result) {
        connection.sendNotification(
          new NotificationType<any, void>("apollographql/queryResult"),
          { result: error.result, cancellationID }
        );
      } else {
        connection.sendNotification(
          new NotificationType<any, void>("apollographql/queryResult"),
          { result: { errors: [error] }, cancellationID }
        );
      }
    }
  );

  connection.sendNotification(
    new NotificationType<any, void>("apollographql/queryResult"),
    { result: "Loading...", cancellationID }
  );

  cancellationFunctions[cancellationID] = () => {
    sub.unsubscribe();
  };
};

const operationHasVariables = (operation: OperationDefinitionNode) => {
  return (
    operation.variableDefinitions && operation.variableDefinitions.length > 0
  );
};

connection.onExecuteCommand(params => {
  switch (params.command) {
    case "apollographql.runQuery":
      const operation = (params.arguments![0] as DocumentNode)
        .definitions[0] as OperationDefinitionNode;
      if (operationHasVariables(operation)) {
        connection.sendNotification(
          new NotificationType<any, void>("apollographql/requestVariables"),
          {
            query: params.arguments![0],
            endpoint: params.arguments![1],
            headers: params.arguments![2],
            schema: params.arguments![3],
            requestedVariables: operation.variableDefinitions!.map(v => {
              return {
                name: v.variable.name.value,
                typeNode: v.type
              };
            })
          }
        );
      } else {
        executeAndNotify(
          params.arguments![0],
          params.arguments![1],
          params.arguments![2],
          {}
        );
      }

      break;

    default:
  }
});

connection.onNotification(
  "apollographql/runQueryWithVariables",
  ({ query, endpoint, headers, variables }) => {
    executeAndNotify(query, endpoint, headers, variables);
  }
);

connection.onNotification("apollographql/cancelQuery", ({ cancellationID }) => {
  cancellationFunctions[cancellationID]();
  delete cancellationFunctions[cancellationID];
});

// Listen on the connection
connection.listen();

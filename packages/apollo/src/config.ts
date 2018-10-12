import { basename, dirname, join, relative, resolve } from "path";
import { fs, withGlobalFS } from "apollo-codegen-core/lib/localfs";

import * as fg from "glob";
import * as minimatch from "minimatch";
import {
  GraphQLSchema,
  extendSchema,
  visit,
  buildASTSchema,
  buildClientSchema
} from "graphql";
import { loadSchema } from "./load-schema";
import { loadQueryDocuments } from "apollo-codegen-core/lib/loading";

export interface EndpointConfig {
  url?: string; // main HTTP endpoint
  subscriptions?: string; // WS endpoint for subscriptions
  headers?: Object; // headers to send when performing operations
  skipSSLValidation?: boolean; // bypass the SSL validation on a HTTPS request
}

export interface SchemaDependency {
  schema?: string;
  endpoint?: EndpointConfig;
  engineKey?: string;
  extends?: string;
  clientSide?: boolean;
}

export interface DocumentSet {
  schema?: string;
  includes: string[];
  excludes: string[];
}

export interface ApolloConfig {
  configFile: string;
  projectFolder: string;
  name?: string;
  schemas?: { [name: string]: SchemaDependency }; // path to JSON introspection, if not provided endpoint will be used
  queries?: DocumentSet[];
  engineEndpoint?: string;
}

function loadEndpointConfig(
  obj: any,
  shouldDefaultURL: boolean
): EndpointConfig | undefined {
  let preSubscriptions: EndpointConfig | undefined;
  if (typeof obj === "string") {
    preSubscriptions = {
      url: obj
    };
  } else {
    preSubscriptions =
      (obj as EndpointConfig | undefined) ||
      (shouldDefaultURL ? { url: "http://localhost:4000/graphql" } : undefined);
  }

  if (
    preSubscriptions &&
    !preSubscriptions.subscriptions &&
    preSubscriptions.url
  ) {
    preSubscriptions.subscriptions = preSubscriptions.url!.replace(
      "http",
      "ws"
    );
  }

  return preSubscriptions;
}

function loadSchemaConfig(
  obj: any,
  defaultEndpoint: boolean
): SchemaDependency {
  return {
    schema: obj.schema,
    endpoint: loadEndpointConfig(
      obj.endpoint,
      !obj.engineKey && defaultEndpoint
    ),
    engineKey: obj.engineKey,
    clientSide: obj.clientSide,
    extends: obj.extends
  };
}

function loadDocumentSet(obj: any): DocumentSet {
  return {
    schema: obj.schema,
    includes:
      typeof obj.includes === "string"
        ? [obj.includes as string]
        : obj.includes
          ? (obj.includes as string[])
          : ["**"],
    excludes:
      typeof obj.excludes === "string"
        ? [obj.excludes as string]
        : obj.excludes
          ? (obj.excludes as string[])
          : ["node_modules/**"]
  };
}

export function loadConfig(
  obj: any,
  configFile: string,
  configDir: string,
  defaultEndpoint: boolean,
  defaultSchema: boolean
): ApolloConfig {
  const schemasObj = (obj.schemas || {}) as { [name: string]: any };
  Object.keys(schemasObj).forEach(key => {
    schemasObj[key] = loadSchemaConfig(schemasObj[key], defaultEndpoint);
  });

  if (Object.keys(schemasObj).length == 0 && defaultSchema) {
    schemasObj["default"] = loadSchemaConfig({}, defaultEndpoint);
  }

  return {
    configFile,
    projectFolder: configDir,
    schemas: schemasObj,
    name: basename(configDir),
    queries: (obj.queries
      ? Array.isArray(obj.queries)
        ? (obj.queries as any[])
        : [obj.queries]
      : Object.keys(schemasObj).length == 1
        ? [{ schema: Object.keys(schemasObj)[0] }]
        : []
    ).map(d => loadDocumentSet(d)),
    engineEndpoint: obj.engineEndpoint
  };
}

export function loadConfigFromFile(
  file: string,
  defaultEndpoint: boolean,
  defaultSchema: boolean
): ApolloConfig {
  if (file.endsWith(".js")) {
    const filepath = resolve(file);
    delete require.cache[require.resolve(filepath)];
    return loadConfig(
      require(filepath),
      filepath,
      dirname(filepath),
      defaultEndpoint,
      defaultSchema
    );
  } else if (file.endsWith("package.json")) {
    const apolloKey = JSON.parse(fs.readFileSync(file).toString()).apollo;
    if (apolloKey) {
      return loadConfig(
        apolloKey,
        file,
        dirname(file),
        defaultEndpoint,
        defaultSchema
      );
    } else {
      return loadConfig(
        {},
        file,
        dirname(file),
        defaultEndpoint,
        defaultSchema
      );
    }
  } else {
    throw new Error("Unsupported config file format");
  }
}

export function findAndLoadConfig(
  dir: string,
  defaultEndpoint: boolean,
  defaultSchema: boolean
): ApolloConfig {
  const apolloPath = dir.match(/\/apollo\.config\.js$/)
    ? dir
    : join(dir, "apollo.config.js");
  if (fs.existsSync(apolloPath)) {
    return loadConfigFromFile(apolloPath, defaultEndpoint, defaultSchema);
  }

  const packagePath = dir.match(/package\.json/)
    ? dir
    : join(dir, "package.json");
  if (fs.existsSync(packagePath)) {
    return loadConfigFromFile(packagePath, defaultEndpoint, defaultSchema);
  }
  return loadConfig({}, dir, dir, defaultEndpoint, defaultSchema);
}

export interface ResolvedDocumentSet {
  schema?: GraphQLSchema;
  endpoint?: EndpointConfig;
  engineKey?: string;

  documentPaths: string[];

  originalSet: DocumentSet;
}

export async function resolveSchema(
  name: string,
  config: ApolloConfig,
  sourceOverride?: string
): Promise<GraphQLSchema | undefined> {
  const referredSchema = (config.schemas || {})[name];

  const loadAsAST = () => {
    const ast = loadQueryDocuments([referredSchema.schema!])[0];
    if (referredSchema.clientSide) {
      visit(ast, {
        enter(node) {
          if (node.kind == "FieldDefinition") {
            (node as any).__client = true;
          }
        }
      });
    }

    return ast;
  };

  return referredSchema.extends
    ? extendSchema(
        (await resolveSchema(referredSchema.extends, config))!,
        loadAsAST()
      )
    : referredSchema.clientSide
      ? buildASTSchema(loadAsAST())
      : await loadSchema(referredSchema, config, sourceOverride).then(
          introspectionSchema => {
            if (!introspectionSchema) return;
            return buildClientSchema({ __schema: introspectionSchema });
          }
        );
}

export async function resolveDocumentSets(
  config: ApolloConfig,
  needSchema: boolean,
  sourceOverride?: string
): Promise<ResolvedDocumentSet[]> {
  return await Promise.all(
    (config.queries || []).map(async doc => {
      const referredSchema = doc.schema
        ? (config.schemas || {})[doc.schema]
        : undefined;

      const schemaPaths: string[] = [];
      let currentSchema = (config.schemas || {})[doc.schema!];
      while (currentSchema) {
        if (currentSchema.schema) {
          schemaPaths.push(currentSchema.schema);
        }

        currentSchema = (config.schemas || {})[currentSchema.extends!];
      }

      return {
        schema:
          needSchema && doc.schema
            ? await resolveSchema(doc.schema, config, sourceOverride)
            : undefined,
        endpoint: referredSchema ? referredSchema.endpoint : undefined,
        engineKey: referredSchema ? referredSchema.engineKey : undefined,
        documentPaths: doc.includes
          .flatMap(i =>
            withGlobalFS(() =>
              fg.sync(i, { cwd: config.projectFolder, absolute: true })
            )
          )
          .filter(
            f =>
              ![...doc.excludes, ...schemaPaths].some(e =>
                minimatch(relative(config.projectFolder, f), e)
              )
          ),
        originalSet: doc
      };
    })
  );
}

import { IntrospectionSchema } from "graphql";
import { ApolloConfig, SchemaDependency } from "./config";
import { fetchSchema, fetchSchemaFromEngine } from "./fetch-schema";

export async function loadSchema(
  dependency: SchemaDependency,
  config: ApolloConfig,
  sourceOverride?: string
): Promise<IntrospectionSchema | undefined> {
  if (sourceOverride) {
    if (sourceOverride === "engine" && dependency.engineKey) {
      return await fetchSchemaFromEngine(
        dependency.engineKey,
        config.engineEndpoint
      );
    } else {
      debugger;
    }
  }

  if (dependency.schema) {
    return await fetchSchema({ url: dependency.schema }, config.projectFolder);
  } else if (dependency.endpoint && dependency.endpoint.url) {
    return await fetchSchema(dependency.endpoint, config.projectFolder);
  } else if (dependency.engineKey) {
    return await fetchSchemaFromEngine(
      dependency.engineKey,
      config.engineEndpoint
    );
  } else {
    return undefined;
  }
}

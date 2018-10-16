jest.mock("@craigrmccown/apollo-codegen-core/lib/localfs", () => {
  return require("../../../__mocks__/localfs");
});

import * as path from "path";
import * as fs from "fs";
import { test as setup } from "apollo-cli-test";
// this is because of herkou-cli-utils hacky mocking system on their console logger
import { stdout as uiLog, mockConsole } from "heroku-cli-util";
import { introspectionQuery, print, execute, buildSchema } from "graphql";
import gql from "graphql-tag";
import { ENGINE_URI } from "../../../engine";
import { UPLOAD_SCHEMA } from "../../../operations/uploadSchema";

import {
  fs as mockFS,
  vol
} from "@craigrmccown/apollo-codegen-core/lib/localfs";

const test = setup.do(() => mockConsole());
const ENGINE_API_KEY = "service:test:1234";
const hash = "12345";
const schemaSource = fs.readFileSync(
  path.resolve(__dirname, "./fixtures/schema.graphql"),
  {
    encoding: "utf-8"
  }
);

const fullSchema = execute(buildSchema(schemaSource), gql(introspectionQuery))
  .data;

const introspectionResult = JSON.stringify({ data: fullSchema });

const localSuccess = nock => {
  nock
    .post("/graphql", {
      query: print(gql(introspectionQuery)),
      operationName: "IntrospectionQuery",
      variables: {}
    })
    .reply(200, { data: fullSchema });
};

const engineSuccess = ({ schema, tag, result } = {}) => nock => {
  nock
    .matchHeader("x-api-key", ENGINE_API_KEY)
    .post("/", {
      operationName: "UploadSchema",
      variables: {
        schema: schema || fullSchema.__schema,
        id: "test",
        tag: tag || "current",
        gitContext: {
          commit: /.+/i,
          remoteUrl: /apollo-cli/i,
          committer: /@/i
        }
      },
      query: print(UPLOAD_SCHEMA)
    })
    .reply(
      200,
      result || {
        data: {
          service: {
            uploadSchema: {
              code: "UPLOAD_SUCCESS",
              message: "upload was successful",
              tag: { tag: tag || "current", schema: { hash: "12345" } }
            }
          }
        }
      }
    );
};

jest.setTimeout(35000);

beforeEach(() => {
  vol.reset();
  vol.fromJSON({
    __blankFileSoDirectoryExists: ""
  });
});

describe("successful uploads", () => {
  test
    .nock("http://localhost:4000", localSuccess)
    .nock(ENGINE_URI, engineSuccess())
    .env({ ENGINE_API_KEY })
    .stdout()
    .command(["schema:publish"])
    .it("calls engine with a schema from the default remote", () => {
      expect(uiLog).toContain("12345");
    });

  test
    .nock("http://localhost:4000", localSuccess)
    .nock(ENGINE_URI, engineSuccess())
    .stdout()
    .command(["schema:publish", `--key=${ENGINE_API_KEY}`])
    .it("allows a custom api key", () => {
      expect(uiLog).toContain("12345");
    });

  test
    .stdout()
    .nock("https://staging.example.com", localSuccess)
    .nock(ENGINE_URI, engineSuccess())
    .env({ ENGINE_API_KEY })
    .command([
      "schema:publish",
      "--endpoint=https://staging.example.com/graphql"
    ])
    .it("calls engine with a schema from a custom remote", ({ stdout }) => {
      expect(uiLog).toContain("12345");
    });

  test
    .do(() =>
      vol.fromJSON({
        "package.json": `
      {
        "apollo": {
          "schemas": {
            "customEndpoint": {
              "endpoint": "https://staging.example.com/graphql",
              "engineKey": "${ENGINE_API_KEY}"
            }
          }
        }
      }
      `
      })
    )
    .stdout()
    .nock("https://staging.example.com", localSuccess)
    .nock(ENGINE_URI, engineSuccess())
    .command(["schema:publish"])
    .it(
      "calls engine with a schema from a custom remote specified in config",
      ({ stdout }) => {
        expect(uiLog).toContain("12345");
      }
    );

  test
    .nock("http://localhost:4000", localSuccess)
    .nock("https://engine.example.com", engineSuccess())
    .env({ ENGINE_API_KEY })
    .stdout()
    .command(["schema:publish", "--engine=https://engine.example.com"])
    .it("calls engine with a schema from a custom registry", () => {
      expect(uiLog).toContain("12345");
    });

  test
    .stdout()
    .nock("https://staging.example.com", nock => {
      nock
        .matchHeader("Authorization", "1234")
        .matchHeader("Hello", "World")
        .post("/graphql", {
          query: print(gql(introspectionQuery)),
          operationName: "IntrospectionQuery",
          variables: {}
        })
        .reply(200, { data: fullSchema });
    })
    .nock(ENGINE_URI, engineSuccess())
    .env({ ENGINE_API_KEY })
    .command([
      "schema:publish",
      "--endpoint=https://staging.example.com/graphql",
      "--header=Authorization: 1234",
      "--header=Hello: World"
    ])
    .it(
      "calls engine with a schema from a custom remote with custom headers",
      ({ stdout }) => {
        expect(uiLog).toContain("12345");
      }
    );

  test
    .do(() =>
      vol.fromJSON({
        "introspection-result.json": introspectionResult.toString()
      })
    )
    .stdout()
    .nock(ENGINE_URI, engineSuccess())
    .env({ ENGINE_API_KEY })
    .command(["schema:publish", "--endpoint=introspection-result.json"])
    .it(
      "calls engine with a schema from an introspection result on the filesystem",
      ({ stdout }) => {
        expect(uiLog).toContain("12345");
      }
    );

  test
    .do(() =>
      vol.fromJSON({
        "schema.graphql": schemaSource
      })
    )
    .stdout()
    .nock(ENGINE_URI, engineSuccess({ schema: fullSchema.__schema }))
    .env({ ENGINE_API_KEY })
    .command(["schema:publish", "--endpoint=schema.graphql"])
    .it(
      "calls engine with a schema from a schema file on the filesystem",
      ({ stdout }) => {
        expect(uiLog).toContain("12345");
      }
    );

  test
    .nock("http://localhost:4000", localSuccess)
    .nock(ENGINE_URI, engineSuccess())
    .env({ ENGINE_API_KEY })
    .stdout()
    .command(["schema:publish", "--json"])
    .it("allows formatting success as JSON", ({ stdout }) => {
      expect(uiLog).toContain('"hash": "12345"');
    });
});

describe("error handling", () => {
  test
    .command(["schema:publish"])
    .catch(err => expect(err.message).toMatch(/No API key/))
    .it("errors with no service api key");

  test
    .nock("http://localhost:4000", localSuccess)
    .nock(
      ENGINE_URI,
      engineSuccess({
        result: {
          data: {
            service: {
              uploadSchema: {
                code: "NO_CHANGES",
                message: "no changes to current",
                tag: { tag: "current", schema: { hash: "12345" } }
              }
            }
          }
        }
      })
    )
    .env({ ENGINE_API_KEY })
    .stdout()
    .command(["schema:publish"])
    .it(
      "gives correct feedback when publishing without changes",
      ({ stdout }) => {
        expect(stdout).toMatch(/No change/);
        expect(uiLog).toContain("12345");
      }
    );
});

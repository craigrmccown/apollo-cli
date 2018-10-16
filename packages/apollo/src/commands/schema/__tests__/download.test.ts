jest.mock("@craigrmccown/apollo-codegen-core/lib/localfs", () => {
  return require("../../../__mocks__/localfs");
});

// this is because of herkou-cli-utils hacky mocking system on their console logger
import { stdout, mockConsole } from "heroku-cli-util";
import * as path from "path";
import * as fs from "fs";
import { test as setup } from "apollo-cli-test";
import { introspectionQuery, print, execute, buildSchema } from "graphql";
import gql from "graphql-tag";
import {
  fs as mockFS,
  vol
} from "@craigrmccown/apollo-codegen-core/lib/localfs";

const test = setup.do(() => mockConsole());
const fullSchema = execute(
  buildSchema(
    fs.readFileSync(path.resolve(__dirname, "./fixtures/schema.graphql"), {
      encoding: "utf-8"
    })
  ),
  gql(introspectionQuery)
).data;

const localSuccess = nock => {
  nock
    .post("/graphql", {
      query: print(gql(introspectionQuery)),
      operationName: "IntrospectionQuery",
      variables: {}
    })
    .reply(200, { data: fullSchema });
};

beforeEach(() => {
  vol.reset();
  vol.fromJSON({
    __blankFileSoDirectoryExists: ""
  });
});

jest.setTimeout(25000);

describe("successful schema downloading", () => {
  test
    .nock("http://localhost:4000", localSuccess)
    .command(["schema:download", "--endpoint=http://localhost:4000/graphql"])
    .it("grabs schema JSON from local server", () => {
      expect(mockFS.readFileSync("schema.json").toString()).toMatchSnapshot();
    });

  test
    .do(() =>
      vol.fromJSON({
        "package.json": `
      {
        "apollo": {
          "schemas": {
            "localServer": {
              "endpoint": "http://localhost:1234/graphql"
            }
          }
        }
      }
      `
      })
    )
    .nock("http://localhost:1234", localSuccess)
    .command(["schema:download"])
    .it("grabs schema JSON from local server specified in config", () => {
      expect(mockFS.readFileSync("schema.json").toString()).toMatchSnapshot();
    });
});

import { window, StatusBarItem, StatusBarAlignment } from "vscode";

export default class ApolloStatusBar {
  private statusBarItem: StatusBarItem = window.createStatusBarItem(
    StatusBarAlignment.Right
  );

  constructor() {
    this.statusBarItem.text = "Apollo GraphQL $(rss)";
    this.statusBarItem.show();
  }

  public showLoadedState() {
    if (!window.activeTextEditor) {
      this.statusBarItem.hide();
      return;
    }

    this.statusBarItem.text = "Apollo GraphQL $(rocket)";
    this.statusBarItem.show();
  }

  public setTagsPopulated(is: boolean) {
    if (is) {
      this.statusBarItem.command = "launchSchemaTagPicker";
    } else {
      this.statusBarItem.command = undefined;
    }
  }

  public dispose() {
    this.statusBarItem.dispose();
  }
}

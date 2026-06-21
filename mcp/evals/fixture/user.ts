import { connect } from "./db";

export class User {
  save(): string {
    return connect();
  }
}

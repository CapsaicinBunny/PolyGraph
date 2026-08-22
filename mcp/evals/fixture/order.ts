import { connect } from "./db";
import { User } from "./user";

export class Order {
  constructor(public user: User) {}

  persist(): string {
    return connect();
  }
}

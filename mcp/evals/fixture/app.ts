import { Order } from "./order";
import { User } from "./user";

export function main(): string {
  const user = new User();
  return new Order(user).persist();
}

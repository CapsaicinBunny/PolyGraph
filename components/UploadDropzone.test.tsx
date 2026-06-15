import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, render, screen } from "@testing-library/react";
import { Provider } from "./ui/provider";
import { UploadDropzone } from "./UploadDropzone";

afterEach(cleanup);

describe("UploadDropzone", () => {
  test("renders the empty-state prompt and folder picker", () => {
    render(
      <Provider>
        <UploadDropzone onResult={() => {}} />
      </Provider>,
    );

    expect(screen.getByText("Drop a project folder")).toBeDefined();
    expect(screen.getByRole("button", { name: /choose folder/i })).toBeDefined();
  });
});

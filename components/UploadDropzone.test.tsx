import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, render, screen } from "@testing-library/react";
import { Provider } from "./ui/provider";
import { UploadDropzone } from "./UploadDropzone";

afterEach(cleanup);

describe("UploadDropzone", () => {
  test("renders the hero, scan action, and folder dropzone", () => {
    render(
      <Provider>
        <UploadDropzone onResult={() => {}} />
      </Provider>,
    );

    expect(screen.getByRole("heading", { name: "PolyGraph" })).toBeDefined();
    expect(screen.getByRole("button", { name: /scan/i })).toBeDefined();
    expect(screen.getByText("Drop a project folder")).toBeDefined();
  });
});

/// <reference types="bun" />

// Ambient declarations so the type checker accepts CSS side-effect imports
// (e.g. `import "@xyflow/react/dist/style.css"`).
declare module "*.css";
declare module "*.scss";

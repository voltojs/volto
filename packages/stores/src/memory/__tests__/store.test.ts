import { createMemoryStore } from "../index.js";
import { runStoreContractTests } from "@voltojs/core/testing";

runStoreContractTests(() => createMemoryStore());

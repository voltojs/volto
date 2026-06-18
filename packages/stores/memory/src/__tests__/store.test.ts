import { createMemoryStore } from "../index.js";
import { runStoreContractTests } from "@volto/core/testing";

runStoreContractTests(() => createMemoryStore());

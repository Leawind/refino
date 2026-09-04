import { createApp } from "vue";
import App from "./App.vue";
import { clientKey, createHttpClient } from "./api";
import { createRefinoI18n } from "./i18n";
import { createStore, storeKey } from "./store";
import "./style.css";
import { createWorkspace, workspaceKey } from "./workspace";

// Composition root of the default shell: the HTTP client against the
// co-hosted `refino web` backend. Embedding hosts (tool plugins, VSCode
// webview, desktop) build their own client and provide the three keys
// themselves instead of using this entry point.
const client = createHttpClient();
const workspace = createWorkspace(client);
const store = createStore(client, workspace);
const i18n = createRefinoI18n(store.state.locale);

createApp(App)
  .use(i18n)
  .provide(clientKey, client)
  .provide(workspaceKey, workspace)
  .provide(storeKey, store)
  .mount("#app");

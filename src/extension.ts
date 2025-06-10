import * as vscode from "vscode";
import { exec } from "child_process";

function execPromise(cmd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    exec(cmd, (error, stdout, stderr) => {
      if (error) {
        reject(error);
      } else if (stderr) {
        reject(new Error(stderr));
      } else {
        resolve(stdout);
      }
    });
  });
}

// Spinner implementation for output channel
class Spinner {
  // private spinnerChars = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
  // private index = 0;
  private intervalId: NodeJS.Timeout | null = null;
  private message: string = "";
  private outputChannel: vscode.OutputChannel;

  constructor(outputChannel: vscode.OutputChannel) {
    this.outputChannel = outputChannel;
  }

  start(message: string): void {
    if (this.intervalId) return; // Spinner is already running

    this.message = message;
    this.outputChannel.append(`${this.message}...`);

    this.intervalId = setInterval(() => {
      // Simpler approach - just append the spinner character
      // this.outputChannel.append("\b" + this.spinnerChars[this.index]);
      this.outputChannel.append(".");
      // this.index = (this.index + 1) % this.spinnerChars.length;
    }, 100);
  }

  stop(success: boolean = true): void {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;

      // Simply append the completion text
      this.outputChannel.append(`${success ? "done" : "failed"}.`);
      // this.outputChannel.appendLine(""); // Add a new line
    }
  }
}

export function activate(context: vscode.ExtensionContext) {
  // Store multiple terminals in an array
  const terminals: vscode.Terminal[] = [];
  // Store output channels in an array
  const outputChannels: vscode.OutputChannel[] = [];

  const disposable = vscode.commands.registerCommand(
    "k8s-service-loader.start",
    async () => {
      // Create unique output channel for this service instance
      const outputChannel = vscode.window.createOutputChannel(
        `K8s Service Loader - ${new Date().toLocaleTimeString()}`
      );
      outputChannels.push(outputChannel);
      outputChannel.show();

      // Create spinner instance
      const spinner = new Spinner(outputChannel);

      try {
        // Get namespaces
        const getNamespacesCommand =
          "kubectl get namespaces -o jsonpath={.items[*].metadata.name}";

        outputChannel.appendLine(`Running: ${getNamespacesCommand}`);
        spinner.start("Loading namespaces");

        const nsOutput = await execPromise(getNamespacesCommand);
        const namespaces: string[] = nsOutput.trim().split(/\s+/);
        spinner.stop();

        const nsPick = await vscode.window.showQuickPick(
          ["-- All Namespaces --", ...namespaces],
          {
            placeHolder: "Select a namespace (or all)",
            ignoreFocusOut: true,
          }
        );
        if (!nsPick) return;
        outputChannel.appendLine(`\nYou selected namespace: ${nsPick}`);
        const namespace = nsPick === "-- All Namespaces --" ? null : nsPick;

        // Get pods
        const getPodsCommand = namespace
          ? `kubectl get pods --namespace ${namespace}`
          : "kubectl get pods --all-namespaces";

        outputChannel.appendLine(`Running: ${getPodsCommand}`);
        spinner.start("Loading services");

        const podsData = await execPromise(getPodsCommand);
        spinner.stop();

        // Process services
        const servicesMap = getServicesMap(podsData, namespace || null);
        const servicesList = Array.from(servicesMap.keys()).sort();

        if (servicesList.length === 0) {
          vscode.window.showInformationMessage("No services found");
          return;
        }

        // Select service
        const selectedService = await vscode.window.showQuickPick(
          servicesList,
          {
            placeHolder: "Select a service",
            ignoreFocusOut: true,
          }
        );

        if (!selectedService) return;

        // Output the selected service
        outputChannel.appendLine(`\nYou selected service: ${selectedService}`);

        // Select environment
        const availableEnvs = Object.keys(
          servicesMap.get(selectedService) || {}
        );
        const environment = await vscode.window.showQuickPick(availableEnvs, {
          placeHolder: "Select environment",
          ignoreFocusOut: true,
        });
        if (!environment) return;

        // Output the selected environment
        outputChannel.appendLine(`Selected environment: ${environment}`);

        // Get service details
        const serviceDetails = servicesMap.get(selectedService)?.[environment];

        // Output service details
        outputChannel.appendLine(`Service ID: ${serviceDetails.id}`);
        outputChannel.appendLine(
          `Service namespace: ${serviceDetails.namespace}`
        );
        outputChannel.appendLine(`Service name: ${serviceDetails.serviceName}`);

        // Get local port
        const localPort =
          (await vscode.window.showInputBox({
            prompt: "Enter local port",
            placeHolder: "3000",
            value: "3000",
            ignoreFocusOut: true,
          })) || "3000";

        // Output the selected local port
        outputChannel.appendLine(`Local port: ${localPort}`);

        // Get service namespace
        const serviceNamespace = namespace || serviceDetails.namespace;
        const serviceName = serviceDetails.serviceName;

        // Get service port
        const getServicePortCommand = `kubectl get service --namespace ${serviceNamespace} ${serviceName} -o jsonpath={.spec.ports[*].port}`;
        outputChannel.appendLine(`Running: ${getServicePortCommand}`);

        spinner.start("Detecting port on the Kubernetes service");

        let servicePort;
        try {
          servicePort = await execPromise(getServicePortCommand);
          spinner.stop();
          outputChannel.appendLine(`\nPort detected: ${servicePort}`);
        } catch (error) {
          spinner.stop(false);
          outputChannel.appendLine(`Error detecting port: ${error}`);
          servicePort = "3000"; // Default value if detection fails
        }

        // Ask user to enter the destination port
        servicePort =
          (await vscode.window.showInputBox({
            prompt: `Enter the destination port on the Kubernetes service. Try using port 3000 if the detected port fails`,
            placeHolder: "3000",
            value: servicePort || "3000",
            ignoreFocusOut: true,
          })) || "3000";

        // Output the selected destination port
        outputChannel.appendLine(`Destination port: ${servicePort}`);

        const portForwardCommand = `kubectl port-forward --namespace ${serviceNamespace} ${serviceName}-${serviceDetails.id} ${localPort}:${servicePort}`;
        outputChannel.appendLine(`Running: ${portForwardCommand}`);
        spinner.start("Initializing port forwarding");

        // Create a new terminal with a unique name
        const terminal = vscode.window.createTerminal({
          name: `k8s — ${selectedService}:${localPort}`,
          iconPath: new vscode.ThemeIcon("diff-renamed"),
          color: new vscode.ThemeColor("terminal.ansiGreen"),
        });
        terminals.push(terminal);
        terminal.show();

        terminal.sendText(portForwardCommand);
        spinner.stop();

        vscode.window.showInformationMessage(
          `Service available at: http://localhost:${localPort}`
        );

        // Ask if user wants to see logs
        const showLogs = await vscode.window.showQuickPick(["Yes", "No"], {
          placeHolder: "Would you like to see the logs in real time?",
          ignoreFocusOut: true,
        });

        if (showLogs === "Yes") {
          const logsCommand = `kubectl logs --namespace ${serviceNamespace} ${serviceName}-${serviceDetails.id} -f`;
          outputChannel.appendLine(`\nRunning: ${logsCommand}`);

          // Create a separate terminal for logs with port information in the name
          const logsTerminal = vscode.window.createTerminal({
            name: `k8s — ${selectedService}:${localPort}`,
            iconPath: new vscode.ThemeIcon("note"),
            color: new vscode.ThemeColor("terminal.ansiYellow"),
          });
          terminals.push(logsTerminal);
          logsTerminal.show();
          logsTerminal.sendText(logsCommand);
        }
      } catch (error) {
        // Make sure spinner is stopped if there's an error
        if (spinner) {
          spinner.stop(false); // Pass false to indicate failure
        }
        vscode.window.showErrorMessage(`Error: ${error}`);
      }
    }
  );

  context.subscriptions.push(disposable);
}

function getServicesMap(podsData: string, namespace: string | null) {
  const servicesMap = new Map();
  const lines = podsData.trim().split("\n");

  // Get headers to find indices
  const headers = lines[0].split(/\s+/);
  const namespaceIndex = headers.indexOf("NAMESPACE");
  const nameIndex = headers.indexOf("NAME");
  const statusIndex = headers.indexOf("STATUS");

  for (let i = 1; i < lines.length; i++) {
    const columns = lines[i].split(/\s+/);

    // Read STATUS column (if present) and skip non-Running entries
    const statusColumn = statusIndex !== -1 ? columns[statusIndex] : undefined;
    if (statusColumn !== undefined && statusColumn !== "Running") {
      continue;
    }

    const namespaceColumn = namespace ?? columns[namespaceIndex];
    const nameColumn = columns[nameIndex];

    // Categorize services by environment based on prefix: "dev-", "qa-", "stg-", "prod-", or "default"
    let envPrefix = "";
    if (nameColumn.startsWith("dev-")) {
      envPrefix = "dev";
    } else if (nameColumn.startsWith("qa-")) {
      envPrefix = "qa";
    } else if (nameColumn.startsWith("stg-")) {
      envPrefix = "stg";
    } else if (nameColumn.startsWith("prod-")) {
      envPrefix = "prod";
    } else {
      envPrefix = "default";
    }

    const parts = nameColumn.split("-");
    if (parts.length > 2) {
      const serviceName = parts.slice(0, -2).join("-");
      const serviceId = parts.slice(-2).join("-");

      let shortServiceName = serviceName.replace(/^(dev-|qa-|stg-|prod-)/, "");
      if (namespaceColumn) {
        shortServiceName = shortServiceName.replace(
          new RegExp(`^${namespaceColumn}-`, "g"),
          ""
        );
      }

      if (!servicesMap.has(shortServiceName)) {
        servicesMap.set(shortServiceName, {});
      }
      servicesMap.get(shortServiceName)[envPrefix] = {
        id: serviceId,
        namespace: namespaceColumn,
        serviceName,
      };
    }
  }
  return servicesMap;
}

export function deactivate() {}

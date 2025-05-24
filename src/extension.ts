import * as vscode from "vscode";
import { exec, spawn } from "child_process";

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
        // Get namespace (optional)
        const namespace = await vscode.window.showInputBox({
          prompt: "Enter namespace (optional)",
          placeHolder: "Leave empty for all namespaces",
          ignoreFocusOut: true,
        });

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
        const envOptions = ["dev", "qa", "stg"];
        const environment = await vscode.window.showQuickPick(envOptions, {
          placeHolder: "Select environment",
          ignoreFocusOut: true,
        });

        if (!environment) return;

        // Output the selected environment
        outputChannel.appendLine(`Selected environment: ${environment}`);

        // Get service details
        const serviceDetails = servicesMap.get(selectedService)?.[environment];
        if (!serviceDetails) {
          vscode.window.showErrorMessage(
            `The selected environment "${environment}" does not exist for the service "${selectedService}"`
          );
          return;
        }

        // Output service details
        outputChannel.appendLine(`Service ID: ${serviceDetails.id}`);
        outputChannel.appendLine(
          `Service namespace: ${serviceDetails.namespace}`
        );

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

        // Get service port
        const getServicePortCommand = `kubectl get service --namespace ${serviceNamespace} ${environment}-${serviceNamespace}-${selectedService} -o jsonpath={.spec.ports[*].port}`;
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

        const portForwardCommand = `kubectl port-forward --namespace ${serviceNamespace} ${environment}-${serviceNamespace}-${selectedService}-${serviceDetails.id} ${localPort}:${servicePort}`;
        outputChannel.appendLine(`Running: ${portForwardCommand}`);
        spinner.start("Initializing port forwarding");

        // Create a new terminal with a unique name
        const terminal = vscode.window.createTerminal(
          `K8s Port Forward (${selectedService}:${localPort})`
        );
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
          const logsCommand = `kubectl logs --namespace ${serviceNamespace} ${environment}-${serviceNamespace}-${selectedService}-${serviceDetails.id} -f`;
          outputChannel.appendLine(`\nRunning: ${logsCommand}`);

          // Create a separate terminal for logs with port information in the name
          const logsTerminal = vscode.window.createTerminal(
            `K8s Logs (${selectedService}:${localPort})`
          );
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

  for (let i = 1; i < lines.length; i++) {
    const columns = lines[i].split(/\s+/);
    const namespaceColumn = namespace ?? columns[namespaceIndex];
    const nameColumn = columns[nameIndex];

    // Only include services that start with "dev-", "qa-" or "stg-"
    let envPrefix = "";
    if (nameColumn.startsWith("dev-")) {
      envPrefix = "dev";
    } else if (nameColumn.startsWith("qa-")) {
      envPrefix = "qa";
    } else if (nameColumn.startsWith("stg-")) {
      envPrefix = "stg";
    } else {
      continue; // Skip this service
    }

    let modifiedName = nameColumn.replace(/^(dev-|qa-|stg-)/, "");

    // Remove namespace part found in the namespace column
    if (namespaceColumn) {
      modifiedName = modifiedName.replace(
        new RegExp(`^${namespaceColumn}-`, "g"),
        ""
      );
    }

    // Split the remaining parts by "-" and extract the last two parts as the ID
    const parts = modifiedName.split("-");
    if (parts.length > 2) {
      const serviceName = parts.slice(0, -2).join("-");
      const serviceId = parts.slice(-2).join("-");
      if (!servicesMap.has(serviceName)) {
        servicesMap.set(serviceName, {});
      }
      servicesMap.get(serviceName)[envPrefix] = {
        id: serviceId,
        namespace: namespaceColumn,
      };
    }
  }
  return servicesMap;
}

export function deactivate() {}

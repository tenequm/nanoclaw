#!/usr/bin/env python3
import argparse
import http.server
import json
import pathlib
import signal
import sys
import uuid
import subprocess
import threading

class ProbeHandler(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        body = b"nanoclaw-host-probe\n"
        self.send_response(200)
        self.send_header("Content-Type", "text/plain")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


parser = argparse.ArgumentParser(description="Probe Mac listeners from a bare Sandbox pod; always clean up.")
parser.add_argument("--image", required=True, help="Pinned base image reference printed by up.sh")
args = parser.parse_args()
directory = pathlib.Path(__file__).resolve().parent
kubectl = ["kubectl", "--kubeconfig", str(directory / ".kubeconfig"), "--context", "kind-nanoclaw-dev", "--request-timeout=15s"]

def k(*args, data=None):
    return subprocess.check_output(kubectl + list(args), input=data, text=True).strip()

address = subprocess.check_output([str(directory / "host-address.sh")], text=True).strip()
def terminate(signum, frame):
    raise SystemExit(128 + signum)


signal.signal(signal.SIGTERM, terminate)
suffix = "host-" + uuid.uuid4().hex
namespace = "nanoclaw-test-" + suffix
servers = []
try:
    try:
        created = subprocess.run([str(directory / "namespace.sh"), "create", suffix], check=True, capture_output=True, text=True)
        sys.stderr.write(created.stderr)
    except subprocess.CalledProcessError as error:
        if "AlreadyExists" in (error.stderr or ""):
            namespace = None
        sys.stderr.write(error.stderr or "")
        raise
    for binding in ["0.0.0.0", "127.0.0.1"]:
        server = http.server.ThreadingHTTPServer((binding, 0), ProbeHandler)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        servers.append((binding, server))
    body = {"apiVersion": "agents.x-k8s.io/v1beta1", "kind": "Sandbox", "metadata": {"name": "host-probe", "namespace": namespace}, "spec": {"podTemplate": {"spec": {"restartPolicy": "Never", "automountServiceAccountToken": False, "containers": [{"name": "agent", "image": args.image, "imagePullPolicy": "IfNotPresent", "command": ["/usr/bin/tini", "--", "sleep", "infinity"]}]}}}}
    k("create", "-f", "-", data=json.dumps(body))
    k("-n", namespace, "wait", "--for=condition=Ready", "sandbox/host-probe", "--timeout=120s")
    for binding, server in servers:
        port = server.server_address[1]
        result = k("-n", namespace, "exec", "host-probe", "--", "curl", "-fsS", "--max-time", "10", "-o", "/dev/null", "-w", "%{http_code}", f"http://{address}:{port}/")
        print(json.dumps({"host": address, "binding": binding, "port": port, "status": result}))
finally:
    for _, server in servers:
        server.shutdown()
        server.server_close()
    if namespace is not None:
        subprocess.run([str(directory / "namespace.sh"), "delete", namespace], check=True, timeout=20)

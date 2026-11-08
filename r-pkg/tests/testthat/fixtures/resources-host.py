#!/usr/bin/env python3
"""JSONL socket peer that exercises resources/* on a view-less R session."""

import argparse
import json
import os
import socket


def main():
    parser = argparse.ArgumentParser()
    for name in ("socket", "ready", "result", "node"):
        parser.add_argument("--" + name, required=True)
    args = parser.parse_args()
    messages = []
    with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as server:
        server.bind(args.socket)
        server.listen(1)
        open(args.ready, "w").close()
        connection, _ = server.accept()
        with connection, connection.makefile("rb") as stream:
            connection.settimeout(15)

            def read():
                line = stream.readline()
                if not line:
                    return None
                value = json.loads(line)
                messages.append(value)
                return value

            def send(value):
                connection.sendall(json.dumps(value).encode() + b"\n")

            def request(identifier, method, params):
                send({"id": identifier, "method": method, "params": params})
                while True:
                    value = read()
                    assert value is not None
                    if value.get("id") == identifier:
                        return value

            hello = read()
            assert hello["method"] == "hello"
            request("list", "resources/children", {})
            request("open", "resources/open", {"node": args.node})
            request("again", "resources/children", {"limit": 1})
            with open(args.result + ".tmp", "w", encoding="utf-8") as output:
                json.dump({"messages": messages}, output)
            os.replace(args.result + ".tmp", args.result)


if __name__ == "__main__":
    main()

# Files guide

## Join a folder and a file name

Call `joinPath(dir, name)`. It adds a forward slash between the two parts:

```ts
joinPath("out", "report.txt"); // "out/report.txt"
```

A trailing slash on `dir` is not doubled.

import { Router, type IRouter, type Request, type Response } from "express";
import { Readable } from "stream";
import { getAuth } from "@clerk/express";
import {
  RequestUploadUrlBody,
  RequestUploadUrlResponse,
  FinalizeUploadBody,
  FinalizeUploadResponse,
} from "@workspace/api-zod";
import { ObjectStorageService, ObjectNotFoundError } from "../lib/objectStorage";
import { ObjectPermission } from "../lib/objectAcl";

const router: IRouter = Router();
const objectStorageService = new ObjectStorageService();

router.post(
  "/storage/uploads/request-url",
  async (req: Request, res: Response) => {
    const auth = getAuth(req);
    if (!auth.userId) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }

    const parsed = RequestUploadUrlBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Missing or invalid required fields" });
      return;
    }

    try {
      const { name, size, contentType } = parsed.data;

      const uploadURL = await objectStorageService.getObjectEntityUploadURL();
      const objectPath = objectStorageService.normalizeObjectEntityPath(
        uploadURL,
      );

      res.json(
        RequestUploadUrlResponse.parse({
          uploadURL,
          objectPath,
          metadata: { name, size, contentType },
        }),
      );
    } catch (error) {
      req.log.error({ err: error }, "Error generating upload URL");
      res.status(500).json({ error: "Failed to generate upload URL" });
    }
  },
);

router.post(
  "/storage/uploads/finalize",
  async (req: Request, res: Response) => {
    const auth = getAuth(req);
    if (!auth.userId) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }

    const parsed = FinalizeUploadBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Missing or invalid objectPath" });
      return;
    }

    try {
      const normalized = await objectStorageService.trySetObjectEntityAclPolicy(
        parsed.data.objectPath,
        { owner: auth.userId, visibility: "private" },
      );
      res.json(FinalizeUploadResponse.parse({ objectPath: normalized }));
    } catch (error) {
      if (error instanceof ObjectNotFoundError) {
        res
          .status(404)
          .json({ error: "Object not found — did the upload PUT complete?" });
        return;
      }
      req.log.error({ err: error }, "Error finalizing upload");
      res.status(500).json({ error: "Failed to finalize upload" });
    }
  },
);

router.get(
  "/storage/public-objects/*filePath",
  async (req: Request, res: Response) => {
    try {
      const raw = req.params.filePath;
      const filePath = Array.isArray(raw) ? raw.join("/") : raw;
      const file = await objectStorageService.searchPublicObject(filePath);
      if (!file) {
        res.status(404).json({ error: "File not found" });
        return;
      }

      const response = await objectStorageService.downloadObject(file);
      res.status(response.status);
      response.headers.forEach((value, key) => res.setHeader(key, value));
      if (response.body) {
        Readable.fromWeb(response.body as ReadableStream<Uint8Array>).pipe(res);
      } else {
        res.end();
      }
    } catch (error) {
      req.log.error({ err: error }, "Error serving public object");
      res.status(500).json({ error: "Failed to serve public object" });
    }
  },
);

router.get(
  "/storage/objects/*path",
  async (req: Request, res: Response) => {
    try {
      const raw = req.params.path;
      const wildcardPath = Array.isArray(raw) ? raw.join("/") : raw;
      const objectPath = `/objects/${wildcardPath}`;

      const objectFile = await objectStorageService.getObjectEntityFile(
        objectPath,
      );

      const auth = getAuth(req);
      const canAccess = await objectStorageService.canAccessObjectEntity({
        userId: auth.userId ?? undefined,
        objectFile,
        requestedPermission: ObjectPermission.READ,
      });

      if (!canAccess) {
        res.status(auth.userId ? 403 : 401).json({
          error: auth.userId ? "Forbidden" : "Unauthorized",
        });
        return;
      }

      const response = await objectStorageService.downloadObject(objectFile);
      res.status(response.status);
      response.headers.forEach((value, key) => res.setHeader(key, value));
      if (response.body) {
        Readable.fromWeb(response.body as ReadableStream<Uint8Array>).pipe(res);
      } else {
        res.end();
      }
    } catch (error) {
      if (error instanceof ObjectNotFoundError) {
        res.status(404).json({ error: "Object not found" });
        return;
      }
      req.log.error({ err: error }, "Error serving object");
      res.status(500).json({ error: "Failed to serve object" });
    }
  },
);

export default router;

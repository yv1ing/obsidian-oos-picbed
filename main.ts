import OSS from "ali-oss";
import { App, Editor, MarkdownView, Notice, Plugin, PluginSettingTab, Setting } from "obsidian";

interface OssPicbedSettings {
    accessKeyId: string;
    accessKeySecret: string;
    bucket: string;
    region: string;
    prefix: string;
    usePublicUrl: boolean;
}

const DEFAULT_SETTINGS: OssPicbedSettings = {
    accessKeyId: "",
    accessKeySecret: "",
    bucket: "",
    region: "",
    prefix: "",
    usePublicUrl: true,
};

const IMAGE_MARKDOWN_REGEX = /!\[.*?\]\((.*?)\)/g;
const PASTED_IMAGE_REGEX = /!\[\[Pasted image.*?\.(?:png|jpe?g|gif|webp|svg)\]\]/gi;
const INPUT_WIDTH = "400px";

class OssUploader {
    private client: OSS;

    constructor(private settings: OssPicbedSettings) {
        this.validateSettings();
        this.client = new OSS({
            accessKeyId: settings.accessKeyId,
            accessKeySecret: settings.accessKeySecret,
            bucket: settings.bucket,
            region: settings.region,
            secure: true,
        });
    }

    private validateSettings(): void {
        if (!this.settings.accessKeyId || !this.settings.accessKeySecret) {
            throw new Error("Access Key ID or Access Key Secret is empty");
        }
        if (!this.settings.bucket || !this.settings.region) {
            throw new Error("Bucket or Region is empty");
        }
    }

    private getPrefix(): string {
        const prefix = this.settings.prefix?.replace(/^\/+|\/+$/g, "");
        return prefix ? `${prefix}/` : "";
    }

    private generateFileName(file: File): string {
        const extension = file.name.split(".").pop() || "";
        return extension ? `${Date.now()}.${extension}` : `${Date.now()}`;
    }

    async upload(file: File): Promise<{ url: string; key: string }> {
        const key = `${this.getPrefix()}${this.generateFileName(file)}`;
        await this.client.put(key, file, {
            mime: file.type || "application/octet-stream",
        });
        return { url: this.getUrl(key), key };
    }

    async delete(key: string): Promise<void> {
        if (!key) return;
        await this.client.delete(key);
    }

    private getUrl(key: string): string {
        if (this.settings.usePublicUrl) {
            const encodedKey = key.split("/").map(encodeURIComponent).join("/");
            return `https://${this.settings.bucket}.${this.settings.region}.aliyuncs.com/${encodedKey}`;
        }
        return this.client.signatureUrl(key, { expires: 3600 });
    }

    static parseKeyFromUrl(url: string): string {
        if (!url) return "";
        try {
            const parsed = new URL(url);
            return decodeURIComponent(parsed.pathname.replace(/^\/+/, ""));
        } catch {
            return url.replace(/^\/+/, "");
        }
    }
}

class OssPicbedSettingTab extends PluginSettingTab {
    constructor(app: App, private plugin: OssPicbedPlugin) {
        super(app, plugin);
    }

    display(): void {
        const { containerEl } = this;
        containerEl.empty();

        this.addTextSetting("Access Key ID", "Aliyun OSS Access Key ID", "accessKeyId", true);
        this.addTextSetting("Access Key Secret", "Aliyun OSS Access Key Secret", "accessKeySecret", true);
        this.addTextSetting("Bucket", "Aliyun OSS bucket name", "bucket", true);
        this.addTextSetting("Region", "Aliyun OSS region (e.g. oss-cn-beijing)", "region", true);
        this.addTextSetting("Prefix", "Optional path prefix for uploaded files", "prefix", false);

        new Setting(containerEl)
            .setName("Use public URL")
            .setDesc("Enable for public bucket, disable for private bucket")
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.usePublicUrl)
                .onChange(async value => {
                    this.plugin.settings.usePublicUrl = value;
                    await this.plugin.saveSettings();
                }));
    }

    private addTextSetting(name: string, desc: string, key: keyof OssPicbedSettings, reinit: boolean): void {
        new Setting(this.containerEl)
            .setName(name)
            .setDesc(desc)
            .addText(text => {
                text.setValue(String(this.plugin.settings[key]))
                    .onChange(async value => {
                        const trimmed = value.trim();
                        (this.plugin.settings[key] as string) = key === "prefix"
                            ? trimmed.replace(/^\/+|\/+$/g, "")
                            : trimmed;
                        await this.plugin.saveSettings();
                        if (reinit) this.plugin.initUploader();
                    });
                text.inputEl.style.width = INPUT_WIDTH;
            });
    }
}

export default class OssPicbedPlugin extends Plugin {
    settings: OssPicbedSettings;
    private uploader: OssUploader | null = null;

    async onload(): Promise<void> {
        await this.loadSettings();
        this.initUploader();
        this.registerPasteHandler();
        this.registerContextMenu();
        this.addSettingTab(new OssPicbedSettingTab(this.app, this));
    }

    onunload(): void {
        this.uploader = null;
    }

    async loadSettings(): Promise<void> {
        this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    }

    async saveSettings(): Promise<void> {
        await this.saveData(this.settings);
    }

    initUploader(): void {
        const { accessKeyId, accessKeySecret, bucket, region } = this.settings;
        if (accessKeyId && accessKeySecret && bucket && region) {
            try {
                this.uploader = new OssUploader(this.settings);
            } catch {
                this.uploader = null;
            }
        }
    }

    private registerPasteHandler(): void {
        this.registerEvent(
            this.app.workspace.on("editor-paste", async (evt: ClipboardEvent, editor: Editor, view: MarkdownView) => {
                if (!this.uploader || !view.file) return;

                const images = Array.from(evt.clipboardData?.items || [])
                    .filter(item => item.kind === "file" && item.type.startsWith("image/"));

                if (images.length === 0) return;

                evt.preventDefault();

                for (const item of images) {
                    const file = item.getAsFile();
                    if (file) await this.handleImageUpload(editor, file);
                }
            })
        );
    }

    private async handleImageUpload(editor: Editor, file: File): Promise<void> {
        const token = this.generateUploadToken();
        editor.replaceRange(token, editor.getCursor());

        try {
            const { url } = await this.uploader!.upload(file);
            this.replaceTokenWithImage(editor, token, url);
            this.cleanupPastedImages(editor);
            new Notice("Image uploaded successfully");
        } catch (error: any) {
            this.removeToken(editor, token);
            new Notice(`Upload failed: ${error?.message || error}`);
        }
    }

    private generateUploadToken(): string {
        return `{{OSS_UPLOADING:${Date.now()}-${Math.random().toString(36).slice(2, 8)}}}`;
    }

    private replaceTokenWithImage(editor: Editor, token: string, url: string): void {
        const content = editor.getValue();
        const index = content.indexOf(token);
        if (index === -1) return;

        const from = editor.offsetToPos(index);
        const to = editor.offsetToPos(index + token.length);
        const markdown = `![](${url})`;

        editor.replaceRange(markdown, from, to);

        const cursor = editor.getCursor();
        if (cursor.line === to.line && cursor.ch === to.ch) {
            editor.setCursor(editor.offsetToPos(index + markdown.length));
        }
    }

    private removeToken(editor: Editor, token: string): void {
        const content = editor.getValue();
        if (!content.includes(token)) return;

        const updated = content.replace(token, "");
        editor.setValue(updated);
        editor.setCursor(editor.offsetToPos(updated.length));
    }

    private cleanupPastedImages(editor: Editor): void {
        let content = editor.getValue();
        PASTED_IMAGE_REGEX.lastIndex = 0;
        let match: RegExpExecArray | null;

        while ((match = PASTED_IMAGE_REGEX.exec(content)) !== null) {
            const start = editor.offsetToPos(match.index);
            const end = editor.offsetToPos(match.index + match[0].length);
            editor.replaceRange("", start, end);
            content = editor.getValue();
            PASTED_IMAGE_REGEX.lastIndex = 0;
        }
    }

    private registerContextMenu(): void {
        this.registerEvent(
            this.app.workspace.on("editor-menu", (menu, editor) => {
                if (!this.uploader) return;

                const cursor = editor.getCursor();
                const line = editor.getLine(cursor.line);
                const imageRegex = /!\[.*?\]\((.*?)\)/;
                const match = line.match(imageRegex);

                if (match?.[1]) {
                    menu.addItem(item => {
                        item.setTitle("Delete this image")
                            .setIcon("trash")
                            .onClick(() => this.deleteImage(editor, match[1], cursor.line));
                    });
                }

                menu.addItem(item => {
                    item.setTitle("Delete all images")
                        .setIcon("trash")
                        .onClick(() => this.deleteAllImages(editor));
                });
            })
        );
    }

    private async deleteImage(editor: Editor, url: string, lineNumber: number): Promise<void> {
        try {
            const key = OssUploader.parseKeyFromUrl(url);
            if (!key) {
                new Notice("Invalid image URL");
                return;
            }

            await this.uploader!.delete(key);
            const line = editor.getLine(lineNumber);
            const updated = line.replace(/!\[.*?\]\(.*?\)/, "");
            editor.setLine(lineNumber, updated);
            new Notice("Image deleted successfully");
        } catch (error: any) {
            new Notice(`Delete failed: ${error?.message || error}`);
        }
    }

    private async deleteAllImages(editor: Editor): Promise<void> {
        const content = editor.getValue();
        IMAGE_MARKDOWN_REGEX.lastIndex = 0;
        const matches = [...content.matchAll(IMAGE_MARKDOWN_REGEX)];

        if (matches.length === 0) {
            new Notice("No images found");
            return;
        }

        const keys = matches.map(match => OssUploader.parseKeyFromUrl(match[1])).filter(Boolean);

        await Promise.all(
            keys.map(key => this.uploader!.delete(key).catch(error =>
                console.error(`Delete failed for ${key}:`, error)
            ))
        );

        IMAGE_MARKDOWN_REGEX.lastIndex = 0;
        editor.setValue(content.replace(IMAGE_MARKDOWN_REGEX, ""));
        new Notice(`Deleted ${keys.length} image(s)`);
    }
}

declare module "*.css";
declare module "*.png?url" {
  const url: string;
  export default url;
}
